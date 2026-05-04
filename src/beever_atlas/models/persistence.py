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
# Message Store (channel_messages collection)
# ---------------------------------------------------------------------------


class ChannelMessage(BaseModel):
    """Durable message representation in the ``channel_messages`` collection.

    Replaces the prior in-memory ``list[NormalizedMessage]`` flow during sync
    with an idempotent persistent store keyed by ``(source_id, channel_id,
    message_id)``. ``extraction_status`` drives the per-message state machine
    consumed by the background ExtractionWorker.

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
    # ``failed → pending`` is the worker auto-retry path.
    "failed": {"pending"},
}


# ---------------------------------------------------------------------------
# Push-source ingest (external_sources + idempotency_keys collections)
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

    secret: str = Field(exclude=True)
    """Plaintext HMAC-SHA256 signing key. Recommended length 32+ bytes
    of random entropy. Stored to support verification.

    ``Field(exclude=True)`` keeps this out of any API response that
    serializes ``ExternalSource`` via ``model_dump()`` / FastAPI's
    automatic Pydantic encoding. The plaintext is intentionally persisted
    (HMAC verification requires the key) but MUST NOT appear in admin /
    list endpoints. Verification reads it directly via
    ``get_external_source`` (see ``api/sources.py``), bypassing the dump
    path."""

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


# ---------------------------------------------------------------------------
# Wiki page-store (wiki_pages collection)
# ---------------------------------------------------------------------------


class WikiPageSection(BaseModel):
    """One section within a wiki page.

    The WikiMaintainer updates these one at a time when new facts arrive,
    preserving unchanged sections byte-identical so page voice doesn't
    drift across incremental rewrites. ``last_facts_hash`` records which
    facts were considered when the section was last written — the
    maintainer compares against the current fact set to decide whether
    the section needs a refresh.
    """

    id: str
    title: str = ""
    content_md: str = ""
    last_facts_hash: str = ""


class WikiTension(BaseModel):
    """A surfaced contradiction between two facts.

    Populated by ``services/contradiction_detector.check_and_supersede``
    (running at ``services/batch_processor.py``) and rendered as a
    Tensions section on the affected pages by the wiki lint pass.
    """

    fact_id: str
    contradicts_fact_id: str
    summary: str = ""
    detected_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))


class WikiPage(BaseModel):
    """Per-page wiki document keyed by ``(channel_id, target_lang, page_id)``.

    Replaces the flat ``pages`` subdoc on the legacy ``wiki_cache`` row.
    Per-page documents enable incremental update, per-page versioning,
    and per-page dirty tracking. ``last_facts_seen`` lets the
    WikiMaintainer route new facts to affected pages deterministically (by
    membership) and skip pages whose fact set hasn't changed.
    """

    channel_id: str
    target_lang: str = "en"
    page_id: str
    """Stable slug for the page within the channel + language. Examples:
    ``topic:auth-redesign``, ``person:alice``, ``decisions``, ``faq``."""

    title: str = ""
    slug: str = ""
    """Stable, human-readable identity for the page within
    ``(channel_id, target_lang)``. Derived at first-touch from the
    page's title (kebab-case + dedupe-suffix); immutable thereafter
    unless the operator explicitly merges or splits. The
    ``wiki-llm-native-redesign`` change promotes this from a
    presentation-only URL helper to a primary identity field — see
    the redesign's ``wiki-page-identity`` capability spec.

    Legacy rows that predate the redesign retain ``slug=""``; the
    Phase-3 migration script backfills them from ``title``. The
    ``wiki_pages_channel_lang_slug_unique`` index uses a partial
    filter so empty slugs do NOT collide during the migration window.
    """

    sections: list[WikiPageSection] = Field(default_factory=list)
    version: int = 1
    is_dirty: bool = False
    """Set by the WikiMaintainer in ``manual`` mode when new facts have
    arrived but the user hasn't clicked ``Maintain Wiki`` yet. The
    Maintain button reads pages where ``is_dirty=True`` and processes
    them on demand."""

    last_facts_seen: list[str] = Field(default_factory=list)
    """Fact IDs that were considered when the page was last written.
    Maintainer diffs the current channel fact set against this list to
    decide which pages have new facts to integrate."""

    tensions: list[WikiTension] = Field(default_factory=list)
    """Inline contradictions surfaced from the contradiction detector."""

    page_voice_seed: str = ""
    """Optional reference excerpt the WikiMaintainer uses to keep the
    rewrite tone consistent. Populated on first generation from the
    original page content; subsequent rewrites preserve it."""

    # ---- wiki-llm-native-redesign fields ----------------------------------
    # The redesign promotes per-page-kind synthesis: each page declares a
    # ``kind`` (topic / entity / decisions / faq / action_items) which
    # selects a distinct synthesis prompt + JSON schema. Cross-links and
    # curation flags also live on the page document so the maintainer can
    # read them without an extra collection lookup. All defaults match
    # the pre-redesign behavior so legacy rows keep working under the
    # ``WIKI_LLM_NATIVE_REDESIGN=False`` flag (the maintainer falls
    # through to the legacy single-prompt path).
    kind: str = "topic"
    """Page kind — drives prompt + schema selection in
    ``WikiMaintainer.apply_update`` when ``WIKI_LLM_NATIVE_REDESIGN`` is
    ON. Allowed values: ``topic`` (default), ``entity``, ``decisions``,
    ``faq``, ``action_items``. Unknown kinds fall through to the legacy
    prompt — additive evolution rather than a closed enum keeps
    forward-compat with future kinds."""

    kind_schema: dict[str, Any] | None = None
    """Structured payload validated against the page's
    ``wiki/schemas/{kind}.json`` schema. Consumed by the MCP
    ``read_wiki_page`` tool so agents can iterate the page
    structurally without re-parsing markdown. ``None`` means the
    maintainer's response failed schema validation twice — the page's
    ``content_md`` is still trustworthy; only the structured surface
    is missing."""

    cross_links: list[str] = Field(default_factory=list)
    """Slugs of other wiki pages this page references via
    ``[[wikilink]]`` syntax. Resolved at maintainer time so the
    renderer doesn't run N fuzzy matches per page render."""

    cross_links_broken: list[str] = Field(default_factory=list)
    """Titles inside ``[[...]]`` that did NOT resolve to an existing
    page. Surfaced in the UI as broken-link indicators with a
    ``Create page?`` affordance. Kept distinct from ``cross_links``
    so resolved + broken state can both be rendered without
    re-running the resolver client-side."""

    pin_state: dict[str, Any] = Field(
        default_factory=lambda: {
            "pinned": False,
            "hidden": False,
            "reason": "",
            "set_by": "",
            "set_at": None,
        }
    )
    """Operator curation flags. Maintainer's ``apply_update`` adds a
    ``do not restructure`` addendum when ``pinned=True``; the
    ``list_pages`` (human scope) excludes pages where ``hidden=True``.
    Curation writes go through ``WikiPageStore.update_pin_state``
    which deliberately does NOT bump ``version`` — flag toggles
    aren't content edits."""

    merged_into: str | None = None
    """When non-null, this page has been merged into the named target
    slug. The wiki HTTP layer issues a 301 to the target on direct
    GETs, the maintainer routes future facts to the target, and the
    page is hidden from human nav. ``None`` is the normal case."""

    created_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))
