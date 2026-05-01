"""Admin-token-gated endpoints that must be available in production.

Distinct from :mod:`beever_atlas.api.dev`, which is mounted only when
``BEEVER_ENV=development``. Routes here run in every environment and are
used by operators (never by end users or the dashboard UI directly).

Auth: ``X-Admin-Token`` header compared against ``BEEVER_ADMIN_TOKEN`` via
:func:`~beever_atlas.infra.auth.require_admin`. User and MCP tokens are NOT
accepted.
"""

from __future__ import annotations

import logging
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from beever_atlas.infra.auth import require_admin
from beever_atlas.models.persistence import ExternalSource
from beever_atlas.stores import get_stores

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)
logger = logging.getLogger(__name__)


@router.get("/mcp-metrics")
async def mcp_metrics() -> dict:
    """Return an aggregated snapshot of MCP tool call metrics (task 7.6).

    Read-only operator view — summarises the in-memory rolling-window counter
    maintained by :mod:`beever_atlas.infra.mcp_metrics`. Shape:

        {
          "window_seconds": 3600,
          "total_calls": int,
          "distinct_principals": int,
          "by_outcome":       {"ok": int, "rate_limited": int, ...},
          "by_principal_tool": [{principal, tool, outcome, count}, ...],
          "by_tool_latency":  {tool: {count, avg_ms, p95_ms}, ...}
        }

    Per-process only — in multi-worker deploys each process reports its own
    slice. An aggregating UI layer can sum them. Principals are the full
    ``mcp:<hash>`` tokens (non-reversible; safe to expose to the admin).
    """
    from beever_atlas.infra import mcp_metrics as metrics_mod

    snapshot = metrics_mod.snapshot_counters()
    return snapshot


@router.post("/mcp-metrics/reset")
async def mcp_metrics_reset() -> dict:
    """Clear the in-memory rolling-window counter. Ops use only."""
    from beever_atlas.infra import mcp_metrics as metrics_mod

    metrics_mod.reset_counters()
    return {"status": "reset"}


# ---------------------------------------------------------------------------
# Push-source registry (admin)
# ---------------------------------------------------------------------------


class CreateSourceRequest(BaseModel):
    """Body for ``POST /api/admin/sources``."""

    source_id: str = Field(min_length=1, max_length=128)
    allowed_channels_pattern: str = Field(default="*", max_length=256)
    description: str = Field(default="", max_length=512)


class SourceListItem(BaseModel):
    """Public shape returned by ``GET /api/admin/sources``.

    Note: the plaintext ``secret`` is NEVER included. Operators see
    ``secret_fingerprint`` (sha256 of the secret) so they can confirm a
    rotation took effect without leaking the key.
    """

    source_id: str
    allowed_channels_pattern: str
    description: str = ""
    secret_fingerprint: str = ""
    created_at: str | None = None
    rotated_at: str | None = None
    idempotency_replay_count_24h: int = 0


class CreateSourceResponse(BaseModel):
    """Body returned ONCE on ``POST`` / ``PATCH /rotate``.

    The ``secret`` field is the plaintext HMAC key — copy it now; it
    cannot be retrieved later.
    """

    source_id: str
    secret: str
    secret_fingerprint: str
    rotated_at: str | None = None


def _generate_secret() -> str:
    """32 bytes of URL-safe entropy (≈ 43 chars). Industry-standard size
    for HMAC-SHA256 keys."""
    return secrets.token_urlsafe(32)


def _to_list_item(source: ExternalSource, replay_count: int) -> SourceListItem:
    return SourceListItem(
        source_id=source.source_id,
        allowed_channels_pattern=source.allowed_channels_pattern,
        description=source.description,
        secret_fingerprint=source.secret_fingerprint,
        created_at=source.created_at.isoformat() if source.created_at else None,
        rotated_at=source.rotated_at.isoformat() if source.rotated_at else None,
        idempotency_replay_count_24h=replay_count,
    )


@router.get("/sources", response_model=list[SourceListItem])
async def list_sources() -> list[SourceListItem]:
    """List all registered push sources for the admin UI."""
    stores = get_stores()
    rows = await stores.mongodb.list_external_sources()
    out: list[SourceListItem] = []
    for src in rows:
        replay_count = await stores.mongodb.count_idempotency_replays_for_source(src.source_id)
        out.append(_to_list_item(src, replay_count))
    return out


@router.post(
    "/sources",
    response_model=CreateSourceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_source(req: CreateSourceRequest) -> CreateSourceResponse:
    """Register a new push source.

    Generates the HMAC secret server-side and returns the plaintext
    ONCE in the response body. Re-fetching this row via ``GET /sources``
    returns only the fingerprint, never the plaintext.
    """
    stores = get_stores()
    existing = await stores.mongodb.get_external_source(req.source_id)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"source_id '{req.source_id}' already exists; use PATCH /rotate to rotate the secret",
        )
    plain_secret = _generate_secret()
    source = ExternalSource(
        source_id=req.source_id,
        secret=plain_secret,
        allowed_channels_pattern=req.allowed_channels_pattern,
        description=req.description,
    )
    await stores.mongodb.upsert_external_source(source)
    # Re-fetch so we get the canonical secret_fingerprint that the upsert
    # path computed (defense-in-depth: never echo a hash we computed
    # ourselves before persistence confirmed it).
    persisted = await stores.mongodb.get_external_source(req.source_id)
    fingerprint = persisted.secret_fingerprint if persisted else ""
    return CreateSourceResponse(
        source_id=req.source_id,
        secret=plain_secret,
        secret_fingerprint=fingerprint,
    )


@router.patch(
    "/sources/{source_id}/rotate",
    response_model=CreateSourceResponse,
)
async def rotate_source_secret(source_id: str) -> CreateSourceResponse:
    """Rotate the HMAC secret for an existing source.

    Old signatures stop verifying immediately; the new plaintext is
    returned ONCE in the response body.
    """
    stores = get_stores()
    existing = await stores.mongodb.get_external_source(source_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"source_id '{source_id}' not registered",
        )
    new_secret = _generate_secret()
    rotated = ExternalSource(
        source_id=source_id,
        secret=new_secret,
        allowed_channels_pattern=existing.allowed_channels_pattern,
        description=existing.description,
        created_at=existing.created_at,
    )
    await stores.mongodb.upsert_external_source(rotated)
    persisted = await stores.mongodb.get_external_source(source_id)
    rotated_at: str | None = None
    fingerprint = ""
    if persisted is not None:
        fingerprint = persisted.secret_fingerprint
        rotated_at = persisted.rotated_at.isoformat() if persisted.rotated_at else None
    return CreateSourceResponse(
        source_id=source_id,
        secret=new_secret,
        secret_fingerprint=fingerprint,
        rotated_at=rotated_at,
    )


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(source_id: str) -> Response:
    """Delete a push source. Subsequent ingest calls return 404."""
    stores = get_stores()
    deleted = await stores.mongodb.delete_external_source(source_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"source_id '{source_id}' not registered",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
