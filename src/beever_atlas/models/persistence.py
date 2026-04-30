"""Persistence models: MongoDB sync state and outbox."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field


class FactStatus(BaseModel):
    """Tracks the storage status of an individual extracted fact."""

    fact_index: int
    status: str = "pending"  # pending | stored | failed
    weaviate_id: str | None = None
    error: str | None = None
    retry_count: int = 0


class SyncJob(BaseModel):
    """Tracks a channel sync job in MongoDB."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    channel_id: str
    status: str = "running"  # running | completed | failed
    sync_type: str = "full"  # full | incremental
    total_messages: int = 0
    parent_messages: int = 0  # top-level messages only (excludes thread replies)
    processed_messages: int = 0
    current_batch: int = 0
    total_batches: int = 0
    batches_completed: int = 0  # atomic counter; honest with concurrent batches
    current_stage: str | None = None
    batch_size: int = 10
    errors: list[str] = Field(default_factory=list)
    batch_results: list[dict[str, Any]] = Field(default_factory=list)
    stage_timings: dict[str, float] = Field(default_factory=dict)
    stage_details: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))
    completed_at: datetime | None = None
    # Batch API fields
    batch_job_state: str | None = None
    batch_job_elapsed_seconds: float | None = None
    version: int = 0
    # Principal id (see `infra/auth.Principal.id`) that created this job.
    # Added by openspec change `atlas-mcp-server` Phase 1 — required by the
    # forthcoming MCP `get_job_status` tool to enforce `job_not_found` for
    # principals that do not own the job. Legacy rows without this field are
    # treated as owned by the ``"legacy:shared"`` sentinel (matching the
    # platform_connections convention at `server/app.py:114`).
    owner_principal_id: str | None = None
    kind: str = "sync"  # "sync" | "wiki_refresh" — used by MCP surface


class ChannelSyncState(BaseModel):
    """Persistent sync state per channel in MongoDB."""

    channel_id: str
    last_sync_ts: str  # ISO-8601 timestamp of last synced message
    total_synced_messages: int = 0
    primary_language: str = "en"
    """BCP-47 language tag for the channel's dominant language. Populated by
    the language detector at ingestion when LANGUAGE_DETECTION_ENABLED=true;
    defaults to "en" for existing channels and when the flag is off.
    """
    primary_language_confidence: float = 0.0
    """Detector confidence [0.0, 1.0] for `primary_language`."""


class WriteIntent(BaseModel):
    """Outbox pattern: a pending write intent in MongoDB."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    facts: list[dict[str, Any]] = Field(default_factory=list)
    entities: list[dict[str, Any]] = Field(default_factory=list)
    relationships: list[dict[str, Any]] = Field(default_factory=list)
    weaviate_done: bool = False
    neo4j_done: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))


class ActivityEvent(BaseModel):
    """An activity event for the dashboard feed."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    event_type: str  # sync_complete, sync_failed, new_entity
    channel_id: str
    details: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))


# ---------------------------------------------------------------------------
# Message Store (PR-A of oss-pipeline-and-wiki-redesign)
# ---------------------------------------------------------------------------


class ChannelMessage(BaseModel):
    """Durable message representation in the ``channel_messages`` collection.

    Replaces the prior in-memory ``list[NormalizedMessage]`` flow during sync
    with an idempotent persistent store keyed by ``(source_id, channel_id,
    message_id)``. ``extraction_status`` drives the per-message state machine
    consumed by the background ExtractionWorker (PR-B).

    See ``openspec/changes/oss-pipeline-and-wiki-redesign/specs/message-store/``.
    """

    # ---- identity (compound unique key) ------------------------------------
    source_id: str
    """Stable source identifier — adapter `source_kind` for pull sources
    (e.g. "slack", "discord", "teams"), or registered push-source id for push
    receivers (e.g. "openclaw-prod"). file imports use ``"file"``."""

    channel_id: str
    message_id: str

    # ---- channel display (for UI label parity in dual-read path) ----------
    channel_name: str = ""

    # ---- content -----------------------------------------------------------
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
    links: list[dict[str, Any]] = Field(default_factory=list)
    raw_metadata: dict[str, Any] = Field(default_factory=dict)

    # ---- extraction state machine -----------------------------------------
    extraction_status: str = "pending"  # pending | extracting | done | failed
    attempt_count: int = 0
    next_attempt_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))
    last_error: str | None = None

    # ---- audit -------------------------------------------------------------
    created_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))


# Allowed transitions for ChannelMessage.extraction_status. Validation lives in
# the store-layer upsert helpers; tests assert illegal transitions are rejected.
EXTRACTION_STATUS_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"extracting"},
    "extracting": {"done", "failed"},
    "done": set(),
    # ``failed → pending`` is the retry path (worker auto-retry, PR-C).
    "failed": {"pending"},
}


# ---------------------------------------------------------------------------
# Push-source ingest (PR-D of oss-pipeline-and-wiki-redesign)
# ---------------------------------------------------------------------------


class ExternalSource(BaseModel):
    """A registered push-source (e.g. OpenClaw, Hermes Agent runtime).

    The plaintext HMAC secret is stored alongside its sha256 fingerprint
    — verification needs the plaintext (HMAC requires the key) and the
    fingerprint lets the registry detect rotation events. At OSS scale
    this is acceptable; an enterprise tier would source the plaintext
    from a KMS (the verification path stays the same — the KMS is just
    a different lookup).

    Rotation: ``upsert_external_source`` sets ``rotated_at`` whenever
    the row is updated, so old in-flight signatures fail validation
    immediately on the next request.
    """

    source_id: str
    """Stable opaque identifier — the URL path component for ingest
    (``POST /api/sources/{source_id}/events``). Convention: lowercase
    with-dashes-or-underscores. Example: ``openclaw-prod``."""

    secret: str
    """Plaintext HMAC-SHA256 signing key. Recommended length 32+ bytes
    of random entropy. Stored to support verification."""

    secret_fingerprint: str = ""
    """sha256 hex of ``secret`` — exposed in admin endpoints so an
    operator can confirm a rotation took effect without leaking the
    actual key. Auto-derived in ``upsert_external_source``."""

    allowed_channels_pattern: str = "*"
    """Glob-style channel filter. ``*`` accepts any channel. Used to
    scope a source to a single workspace or owner without coupling auth
    to the URL path."""

    description: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))
    rotated_at: datetime | None = None


class IdempotencyKeyRecord(BaseModel):
    """One row per ``(source_id, idempotency_key)`` reservation.

    Auto-expires via Mongo TTL after 24h so retries within the
    advertised replay window return the cached 202 response and
    retries beyond it (where re-processing is fine because content-
    hash deterministic IDs prevent duplicates) hit the slow path.
    """

    source_id: str
    idempotency_key: str
    response: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))
