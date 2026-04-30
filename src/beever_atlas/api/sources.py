"""Push-source ingest endpoint (PR-D).

Lets external agent runtimes (OpenClaw, Hermes Agent) push messages
into Beever Atlas's durable Message Store via:

    POST /api/sources/{source_id}/events
    Headers:
      X-Beever-Signature: t=<unix_ts>,v1=<hex>
      X-Beever-Idempotency-Key: <opaque>   (optional, 24h replay cache)
    Body: {"channel_id": str, "events": [PushEvent...]}

The payload lands in ``channel_messages`` with the registered
``source_id`` (preserves source provenance for queries) and
``extraction_status="pending"`` so the worker (PR-B) picks them up
in the next tick. Returns 202 Accepted with counters for the
sender — it should NOT block on extraction completion.

Spec: ``openspec/changes/oss-pipeline-and-wiki-redesign/specs/push-source-ingestion/``
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from beever_atlas.models.persistence import ChannelMessage
from beever_atlas.services.push_hmac import verify_push_signature
from beever_atlas.stores import get_stores

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / response shapes
# ---------------------------------------------------------------------------


class PushEvent(BaseModel):
    """One message in a push batch."""

    message_id: str
    """Source-stable identifier — combined with the path's ``source_id``
    and the body's ``channel_id`` forms the dedup key in
    ``channel_messages``."""

    timestamp: datetime
    author: str = ""
    author_name: str = ""
    author_image: str = ""
    content: str = ""
    thread_id: str | None = None
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    reactions: list[dict[str, Any]] = Field(default_factory=list)
    reply_count: int = 0
    is_bot: bool = False
    raw_metadata: dict[str, Any] = Field(default_factory=dict)


class PushEventRequest(BaseModel):
    """Body of the POST /api/sources/{source_id}/events request."""

    channel_id: str
    """Logical channel within the source (the source decides what
    counts as a channel — e.g. an OpenClaw conversation id, a Hermes
    agent session id)."""

    channel_name: str = ""
    """Optional display label so the UI doesn't have to look up the
    channel by id every time. Defaults to ``channel_id``."""

    events: list[PushEvent]


class PushEventResponse(BaseModel):
    """202 Accepted body."""

    accepted: int
    deduplicated: int
    channel_id: str
    extraction: str = "queued"


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post(
    "/api/sources/{source_id}/events",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=PushEventResponse,
)
async def post_source_events(
    source_id: str,
    request: Request,
    x_beever_signature: str | None = Header(default=None, alias="X-Beever-Signature"),
    x_beever_idempotency_key: str | None = Header(default=None, alias="X-Beever-Idempotency-Key"),
) -> PushEventResponse:
    """Accept a signed batch of push events and queue them for extraction.

    The whole pipeline is intentionally HMAC-only — there's no Bearer
    token auth here because the source is a server-to-server peer that
    doesn't have a user principal. Auth is the per-source HMAC secret.

    Replay protection has two layers:
      1. ``±5 min`` timestamp skew window from the signature header.
      2. ``X-Beever-Idempotency-Key`` 24h replay cache (optional but
         strongly encouraged for retries).
    """
    stores = get_stores()
    body = await request.body()

    # Look up the source's HMAC secret (stored as sha256 hash, but we
    # need the plaintext to recompute the signature — so the source's
    # original secret is recovered out-of-band, not stored. We store
    # only the hash to detect rotation events.)
    #
    # Actually we DO need the plaintext: HMAC verification requires the
    # key. The hash-stored variant uses a separate secret-resolver.
    # For simplicity here we store the secret directly in a
    # ``secret_plaintext`` field on the source registration when admin
    # registers it. This is a pragmatic OSS-scale choice; enterprise
    # would source from a KMS / secret manager.
    source = await stores.mongodb.get_external_source(source_id)
    if source is None:
        # Generic 401 — do not leak whether the source exists.
        logger.warning("push_signature_rejected source_id=%s reason=unknown_source", source_id)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")

    result = verify_push_signature(x_beever_signature or "", body, source.secret)
    if not result.ok:
        logger.warning(
            "push_signature_rejected source_id=%s reason=%s",
            source_id,
            result.reason,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")

    # Idempotency replay cache lookup BEFORE upserting events.
    if x_beever_idempotency_key:
        cached = await stores.mongodb.get_idempotency_record(source_id, x_beever_idempotency_key)
        if cached is not None:
            logger.info(
                "push_idempotent_replay source_id=%s key=%s",
                source_id,
                x_beever_idempotency_key,
            )
            return PushEventResponse(**cached.response)

    # Validate body. (FastAPI does this implicitly when we pass the
    # body as a Pydantic param, but here we sign over raw bytes so we
    # need to read+parse manually.)
    try:
        import json

        payload = PushEventRequest.model_validate(json.loads(body))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Malformed body: {type(exc).__name__}",
        ) from exc

    # Enforce the source's allowed_channels_pattern. ``*`` accepts all.
    pattern = source.allowed_channels_pattern or "*"
    if pattern != "*":
        import fnmatch

        if not fnmatch.fnmatch(payload.channel_id, pattern):
            logger.warning(
                "push_channel_rejected source_id=%s channel_id=%s pattern=%s",
                source_id,
                payload.channel_id,
                pattern,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="channel_id not allowed for this source",
            )

    # Convert each PushEvent to a ChannelMessage and bulk-upsert. The
    # PR-A.1 unique compound index on (source_id, channel_id, message_id)
    # gives us idempotency for free — re-delivery of the same message_id
    # is a no-op.
    rows: list[ChannelMessage] = []
    channel_name = payload.channel_name or payload.channel_id
    for ev in payload.events:
        rows.append(
            ChannelMessage(
                source_id=source_id,
                channel_id=payload.channel_id,
                channel_name=channel_name,
                message_id=ev.message_id,
                timestamp=ev.timestamp,
                author=ev.author,
                author_name=ev.author_name,
                author_image=ev.author_image,
                content=ev.content,
                thread_id=ev.thread_id,
                attachments=ev.attachments,
                reactions=ev.reactions,
                reply_count=ev.reply_count,
                is_bot=ev.is_bot,
                raw_metadata=ev.raw_metadata,
                # extraction_status defaults to "pending" — worker handles it.
            )
        )

    upsert_result = await stores.mongodb.upsert_channel_messages(rows)
    accepted = int(upsert_result.get("inserted", 0))
    deduplicated = int(upsert_result.get("matched", 0))

    response = PushEventResponse(
        accepted=accepted,
        deduplicated=deduplicated,
        channel_id=payload.channel_id,
        extraction="queued",
    )

    # Cache the response for the idempotency window.
    if x_beever_idempotency_key:
        await stores.mongodb.reserve_idempotency_record(
            source_id,
            x_beever_idempotency_key,
            response.model_dump(mode="json"),
        )

    logger.info(
        "push_events_accepted source_id=%s channel=%s accepted=%d deduped=%d",
        source_id,
        payload.channel_id,
        accepted,
        deduplicated,
    )
    return response
