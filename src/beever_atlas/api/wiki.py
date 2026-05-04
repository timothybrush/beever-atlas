"""Wiki generation API endpoints."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, RedirectResponse
from pydantic import BaseModel, Field

from beever_atlas.infra.auth import Principal, require_user
from beever_atlas.infra.channel_access import assert_channel_access
from beever_atlas.infra.config import get_settings
from beever_atlas.stores import get_stores
from beever_atlas.wiki.cache import WikiCache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/channels/{channel_id}/wiki", tags=["wiki"])


_wiki_cache: WikiCache | None = None


def _get_cache() -> WikiCache:
    global _wiki_cache
    if _wiki_cache is None:
        settings = get_settings()
        _wiki_cache = WikiCache(settings.mongodb_uri)
    return _wiki_cache


async def _resolve_target_lang(channel_id: str, requested: str | None) -> str:
    """Resolve and validate the requested target language for a channel."""
    settings = get_settings()
    default_lang = settings.default_target_language

    if requested is None:
        return default_lang

    # Allow-list is the global supported language set (union with default).
    # Fresh channels with no sync state must not be pinned to "en".
    allowed = set(settings.supported_languages_list) | {default_lang}

    stores = get_stores()
    try:
        state = await stores.mongodb.get_channel_sync_state(channel_id)
    except Exception:  # noqa: BLE001
        state = None
    if state is not None:
        primary_language = getattr(state, "primary_language", None)
        if primary_language:
            allowed.add(primary_language)

    if requested in allowed:
        return requested
    raise HTTPException(
        status_code=400,
        detail={"error": "unsupported_target_lang", "allowed": sorted(allowed)},
    )


@router.get("")
async def get_wiki(
    channel_id: str,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Return the full cached wiki for a channel."""
    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    lang = await _resolve_target_lang(channel_id, target_lang)
    doc = await cache.get_wiki(channel_id, target_lang=lang)
    if doc is None:
        raise HTTPException(status_code=404, detail="No wiki available yet")
    return doc


@router.get("/pages/{page_id}")
async def get_wiki_page(
    channel_id: str,
    page_id: str,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Return a single wiki page from cache."""
    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    lang = await _resolve_target_lang(channel_id, target_lang)
    page = await cache.get_page(channel_id, page_id, target_lang=lang)
    if page is None:
        raise HTTPException(status_code=404, detail=f"Page {page_id!r} not found")
    return page


@router.get("/structure")
async def get_wiki_structure(
    channel_id: str,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Return the wiki sidebar structure without page content."""
    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    lang = await _resolve_target_lang(channel_id, target_lang)
    doc = await cache.get_structure(channel_id, target_lang=lang)
    if doc is None:
        raise HTTPException(status_code=404, detail="No wiki structure available yet")
    return doc


@router.get("/versions")
async def list_wiki_versions(
    channel_id: str,
    principal: Principal = Depends(require_user),
) -> list[dict]:
    """Return a list of archived wiki version summaries for a channel."""
    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    return await cache.version_store.list_versions(channel_id)


@router.get("/versions/{version_number}")
async def get_wiki_version(
    channel_id: str,
    version_number: int,
    principal: Principal = Depends(require_user),
) -> dict:
    """Return the full content of a specific archived wiki version."""
    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    version = await cache.version_store.get_version(channel_id, version_number)
    if version is None:
        raise HTTPException(
            status_code=404,
            detail=f"Version {version_number} not found for this channel",
        )
    return version


@router.get("/versions/{version_number}/pages/{page_id}")
async def get_wiki_version_page(
    channel_id: str,
    version_number: int,
    page_id: str,
    principal: Principal = Depends(require_user),
) -> dict:
    """Return a single page from an archived wiki version."""
    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    page = await cache.version_store.get_version_page(channel_id, version_number, page_id)
    if page is None:
        raise HTTPException(
            status_code=404,
            detail=f"Page {page_id!r} not found in version {version_number}",
        )
    return page


@router.get("/download")
async def download_wiki_markdown(
    channel_id: str,
    principal: Principal = Depends(require_user),
) -> PlainTextResponse:
    """Export the full wiki as a single Markdown file."""
    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    doc = await cache.get_wiki(channel_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="No wiki available yet")

    structure = doc.get("structure", {})
    pages_dict = doc.get("pages", {})
    channel_name = structure.get("channel_name", channel_id)

    # Build page order from structure
    page_order: list[str] = []
    for node in structure.get("pages", []):
        page_order.append(node["id"])
        for child in node.get("children", []):
            page_order.append(child["id"])

    # Assemble Markdown
    parts: list[str] = [f"# {channel_name} — Wiki\n"]
    for page_id in page_order:
        page = pages_dict.get(page_id)
        if not page:
            continue
        title = page.get("title", page_id)
        section = page.get("section_number", "")
        prefix = f"{section} " if section else ""
        parts.append(f"\n---\n\n## {prefix}{title}\n")
        parts.append(page.get("content", ""))
        # Append citations
        citations = page.get("citations", [])
        if citations:
            parts.append("\n\n### Sources\n")
            for cit in citations:
                author = cit.get("author", "")
                ts = cit.get("timestamp", "")
                excerpt = cit.get("text_excerpt", "")
                link = cit.get("permalink", "")
                parts.append(f"- {cit.get('id', '')} @{author} · {ts} — {excerpt} [{link}]({link})")
        parts.append("\n")

    md_content = "\n".join(parts)
    filename = f"{channel_name.replace(' ', '-').lower()}-wiki.md"
    from urllib.parse import quote

    safe_ascii = (
        filename.encode("ascii", "ignore")
        .decode()
        .replace('"', "")
        .replace("\r", "")
        .replace("\n", "")
    ) or "wiki.md"
    encoded = quote(filename, safe="")

    return PlainTextResponse(
        content=md_content,
        media_type="text/markdown",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{safe_ascii}\"; filename*=UTF-8''{encoded}"
            ),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/status")
async def get_wiki_status(
    channel_id: str,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Return the current wiki generation status for a channel."""
    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    lang = await _resolve_target_lang(channel_id, target_lang)
    status = await cache.get_generation_status(channel_id, target_lang=lang)
    if status is None:
        return {"status": "idle", "channel_id": channel_id}
    return status


@router.post("/refresh", status_code=202)
async def refresh_wiki(
    channel_id: str,
    background_tasks: BackgroundTasks,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Trigger async wiki generation for a channel."""
    await assert_channel_access(principal, channel_id)
    from beever_atlas.wiki.builder import WikiBuilder

    stores = get_stores()
    cache = _get_cache()
    lang = await _resolve_target_lang(channel_id, target_lang)
    builder = WikiBuilder(stores.weaviate, stores.graph, cache)

    # Set status to "running" immediately so the frontend sees it on first poll
    await cache.set_generation_status(
        channel_id,
        status="running",
        stage="starting",
        stage_detail="Initiating wiki generation…",
        target_lang=lang,
    )

    background_tasks.add_task(_run_generation, builder, channel_id, cache, lang)
    return {"status": "started", "channel_id": channel_id}


async def _run_generation(
    builder, channel_id: str, cache: WikiCache, target_lang: str = "en"
) -> None:
    try:
        await builder.refresh_wiki(channel_id, target_lang=target_lang)
    except Exception as exc:
        logger.error("Wiki generation failed channel=%s: %s", channel_id, exc, exc_info=True)
        await cache.set_generation_status(
            channel_id,
            status="failed",
            stage="error",
            error=str(exc),
            target_lang=target_lang,
        )


# ---------------------------------------------------------------------------
# Wiki health endpoints — lint + on-demand maintenance
# ---------------------------------------------------------------------------


@router.post("/lint")
async def lint_wiki(
    channel_id: str,
    target_lang: str | None = Query(default=None),
    run_coherence_check: bool = Query(default=True),
    principal: Principal = Depends(require_user),
) -> dict:
    """Run wiki lint checks for a channel and return findings.

    Three deterministic checks (orphan / stale / duplicate-section)
    + one bounded LLM coherence pass per page (max 1 call per page).
    Returns ``{channel_id, target_lang, pages_scanned, findings}``.
    Always 200 — an empty findings list is the healthy-channel response.
    """
    from beever_atlas.services.wiki_lint import lint_channel_wiki
    from beever_atlas.wiki.page_store import WikiPageStore

    await assert_channel_access(principal, channel_id)
    cache = _get_cache()
    await cache._ensure_db()
    lang = await _resolve_target_lang(channel_id, target_lang)

    page_store = WikiPageStore(db=cache._db)
    # Live cluster ids — orphan detection compares against the channel's
    # current TopicCluster set in Weaviate.
    stores = get_stores()
    live_cluster_ids: set[str] = set()
    try:
        clusters = await stores.weaviate.list_clusters(channel_id)
        live_cluster_ids = {str(getattr(c, "id", "") or "") for c in clusters}
    except Exception:  # noqa: BLE001
        logger.warning(
            "lint_wiki: could not enumerate live clusters channel=%s — orphan detection will skip",
            channel_id,
        )

    report = await lint_channel_wiki(
        channel_id=channel_id,
        page_store=page_store,
        target_lang=lang,
        live_cluster_ids=live_cluster_ids,
        run_coherence_check=run_coherence_check,
        llm_provider=None,  # Production wires LLMProvider here
    )
    return report.model_dump(mode="json")


@router.post("/maintain")
async def maintain_wiki(
    channel_id: str,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Drain the dirty page queue for one channel.

    Manual mode receiver for the "Maintain Wiki" button. The maintainer
    reads pages where ``is_dirty=True`` and runs the per-page LLM
    section-patch on each one, preserving title / slug / unaffected
    sections byte-identical so page voice does not drift.

    Returns ``{rewritten, errors}`` counters. Always 200 — a degraded
    channel returns ``errors > 0`` rather than failing the request.
    """
    from beever_atlas.services.wiki_maintainer import get_wiki_maintainer

    await assert_channel_access(principal, channel_id)
    lang = await _resolve_target_lang(channel_id, target_lang)

    maintainer = get_wiki_maintainer()
    if maintainer is None:
        # Maintainer not wired in this deployment — manual mode is the
        # default but the singleton is initialised by the FastAPI lifespan.
        # Once the lifespan wires the singleton, this branch falls away.
        return {"rewritten": 0, "errors": 0, "reason": "maintainer_not_initialized"}

    counters = await maintainer.maintain_now(channel_id, target_lang=lang)
    logger.info(
        "wiki_maintain channel=%s rewritten=%d errors=%d",
        channel_id,
        counters.get("rewritten", 0),
        counters.get("errors", 0),
    )
    return counters


# ---------------------------------------------------------------------------
# wiki-llm-native-redesign — curation endpoints (§5.1–§5.4)
# ---------------------------------------------------------------------------


class _PinBody(BaseModel):
    """POST /pin body."""

    reason: str = Field(default="", max_length=512)
    # ``pinned`` defaults to True so a vanilla POST pins. The frontend
    # can flip it to False to unpin without needing a separate endpoint.
    pinned: bool = True


class _HideBody(BaseModel):
    """POST /hide body."""

    reason: str = Field(default="", max_length=512)
    hidden: bool = True


class _SplitBody(BaseModel):
    """POST /split body — extract a subset of facts to a new page."""

    new_title: str = Field(min_length=1, max_length=256)
    fact_ids: list[str] = Field(default_factory=list, max_length=1000)


class _MergeBody(BaseModel):
    """POST /merge body — collapse ``source_slug`` into the URL slug."""

    source_slug: str = Field(min_length=1, max_length=256)


def _slugify_title(title: str) -> str:
    """Match the maintainer's slug derivation — ascii-only kebab-case.

    Aligned with ``WikiMaintainer.apply_update``'s
    ``page_id.replace(":", "-")`` fallback so split-created pages get
    stable slugs that don't collide with topic / entity prefixes.
    """
    out: list[str] = []
    for ch in title.strip().lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "_", "/"):
            out.append("-")
    cleaned = "".join(out).strip("-")
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned or "untitled"


async def _load_page_store():
    """Centralised page-store handle for the curation endpoints.

    Mirrors the ``cache._db`` access pattern used by ``lint_wiki`` so
    the new endpoints reuse the same Mongo connection pool.
    """
    from beever_atlas.wiki.page_store import WikiPageStore

    cache = _get_cache()
    await cache._ensure_db()
    return WikiPageStore(db=cache._db)


@router.post("/pages/{slug}/pin")
async def pin_wiki_page(
    channel_id: str,
    slug: str,
    body: _PinBody,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Mark a page as pinned (or unpinned when ``pinned=false``).

    Pinned pages still receive content updates from the maintainer but
    the prompt addendum constrains them to ``do not restructure
    sections, do not rename`` — preserving the operator's editorial
    intent. ``version`` is NOT bumped (curation, not content).
    """
    await assert_channel_access(principal, channel_id)
    lang = await _resolve_target_lang(channel_id, target_lang)
    store = await _load_page_store()
    existing = await store.get_page_by_slug(channel_id, slug, target_lang=lang)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"No wiki page slug={slug!r}")
    new_state: dict[str, object] = {
        "pinned": bool(body.pinned),
        "hidden": bool(existing.pin_state.get("hidden", False)),
        "reason": body.reason or existing.pin_state.get("reason", ""),
        "set_by": principal.id,
        "set_at": datetime.now(tz=UTC).isoformat(),
    }
    updated = await store.update_pin_state(channel_id, slug, new_state, target_lang=lang)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"No wiki page slug={slug!r}")
    return updated.model_dump(mode="json")


@router.post("/pages/{slug}/hide")
async def hide_wiki_page(
    channel_id: str,
    slug: str,
    body: _HideBody,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Mark a page hidden from human nav (still indexed for agents).

    Sets ``pin_state.hidden = body.hidden``. Hidden pages are excluded
    from ``list_pages_by_kind(scope="human")`` but ``scope="all"``
    still returns them so the MCP read tools (with the appropriate
    scope) can serve them to agents.
    """
    await assert_channel_access(principal, channel_id)
    lang = await _resolve_target_lang(channel_id, target_lang)
    store = await _load_page_store()
    existing = await store.get_page_by_slug(channel_id, slug, target_lang=lang)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"No wiki page slug={slug!r}")
    new_state: dict[str, object] = {
        "pinned": bool(existing.pin_state.get("pinned", False)),
        "hidden": bool(body.hidden),
        "reason": body.reason or existing.pin_state.get("reason", ""),
        "set_by": principal.id,
        "set_at": datetime.now(tz=UTC).isoformat(),
    }
    updated = await store.update_pin_state(channel_id, slug, new_state, target_lang=lang)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"No wiki page slug={slug!r}")
    return updated.model_dump(mode="json")


@router.post("/pages/{slug}/split", status_code=201)
async def split_wiki_page(
    channel_id: str,
    slug: str,
    body: _SplitBody,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Split a subset of a page's facts into a new page.

    Creates a placeholder page seeded with the operator's title, kind
    derived from the source's kind, and ``last_facts_seen`` carrying
    the moved fact ids. The source page's ``last_facts_seen`` shrinks
    by the same set so the maintainer doesn't keep treating those
    facts as "already integrated here". The new page is is_dirty=True
    so the maintainer's next pass rewrites it from the moved facts.
    """
    from beever_atlas.models.persistence import WikiPage, WikiPageSection

    await assert_channel_access(principal, channel_id)
    lang = await _resolve_target_lang(channel_id, target_lang)
    if not body.fact_ids:
        raise HTTPException(status_code=400, detail="fact_ids must not be empty for split")
    store = await _load_page_store()
    source = await store.get_page_by_slug(channel_id, slug, target_lang=lang)
    if source is None:
        raise HTTPException(status_code=404, detail=f"No wiki page slug={slug!r}")

    new_slug = _slugify_title(body.new_title)
    if new_slug == source.slug:
        raise HTTPException(
            status_code=400, detail="new_title must yield a slug different from source"
        )
    # Reject if the destination slug already exists — splits must not
    # silently merge into an unrelated page.
    if await store.get_page_by_slug(channel_id, new_slug, target_lang=lang):
        raise HTTPException(
            status_code=409,
            detail=f"slug {new_slug!r} already exists; choose a different title",
        )

    moved = [fid for fid in body.fact_ids if fid in set(source.last_facts_seen)]
    new_page = WikiPage(
        channel_id=channel_id,
        target_lang=lang,
        page_id=f"topic:{new_slug}",
        title=body.new_title,
        slug=new_slug,
        kind=source.kind,
        sections=[WikiPageSection(id="overview", title="Overview", content_md="")],
        last_facts_seen=moved,
        is_dirty=True,
        page_voice_seed=source.page_voice_seed,
    )
    await store.save_page(new_page)
    if moved:
        await store.remove_facts_from_page(channel_id, slug, moved, target_lang=lang)
    return {
        "source_slug": slug,
        "new_slug": new_slug,
        "moved_fact_count": len(moved),
        "new_page": (
            await store.get_page_by_slug(channel_id, new_slug, target_lang=lang)
        ).model_dump(mode="json")
        if moved is not None
        else None,
    }


@router.post("/pages/{slug}/merge")
async def merge_wiki_page(
    channel_id: str,
    slug: str,
    body: _MergeBody,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Mark ``body.source_slug`` as merged into the URL ``slug``.

    The source page is hidden from human nav and its ``merged_into``
    field carries the target slug. Future fact routing in
    ``WikiMaintainer.plan_updates`` re-routes any plan_updates entry
    keyed to the source's page_id to the target so subsequent batches
    flow into the canonical page.
    """
    await assert_channel_access(principal, channel_id)
    lang = await _resolve_target_lang(channel_id, target_lang)
    if body.source_slug == slug:
        raise HTTPException(status_code=400, detail="source_slug must differ from target slug")
    store = await _load_page_store()
    target = await store.get_page_by_slug(channel_id, slug, target_lang=lang)
    if target is None:
        raise HTTPException(status_code=404, detail=f"No target wiki page slug={slug!r}")
    source = await store.get_page_by_slug(channel_id, body.source_slug, target_lang=lang)
    if source is None:
        raise HTTPException(
            status_code=404,
            detail=f"No source wiki page slug={body.source_slug!r}",
        )
    updated = await store.record_merged_into(channel_id, body.source_slug, slug, target_lang=lang)
    if updated is None:
        raise HTTPException(
            status_code=404,
            detail=f"No source wiki page slug={body.source_slug!r}",
        )
    return {
        "source_slug": body.source_slug,
        "target_slug": slug,
        "source": updated.model_dump(mode="json"),
    }


@router.get("/pages-by-slug/{slug}")
async def get_wiki_page_by_slug(
    channel_id: str,
    slug: str,
    target_lang: str | None = Query(default=None),
    principal: Principal = Depends(require_user),
) -> dict:
    """Resolve a slug to its page (or follow a merge redirect).

    When the page has ``merged_into`` set, the response is a 301
    redirect to the canonical target's slug — the operator UI follows
    the redirect transparently.
    """
    await assert_channel_access(principal, channel_id)
    lang = await _resolve_target_lang(channel_id, target_lang)
    store = await _load_page_store()
    page = await store.get_page_by_slug(channel_id, slug, target_lang=lang)
    if page is None:
        raise HTTPException(status_code=404, detail=f"No wiki page slug={slug!r}")
    if page.merged_into:
        return RedirectResponse(  # type: ignore[return-value]
            url=f"/api/channels/{channel_id}/wiki/pages-by-slug/{page.merged_into}",
            status_code=301,
        )
    return page.model_dump(mode="json")


# ---------------------------------------------------------------------------
# wiki-llm-native-redesign §6 — wiki graph view
# ---------------------------------------------------------------------------


@router.get("/graph")
async def get_wiki_graph(
    channel_id: str,
    principal: Principal = Depends(require_user),
) -> dict:
    """Return the channel's wiki graph in Cytoscape.js format.

    Always 200 — empty channel returns ``{nodes: [], edges: []}`` so
    the frontend can render an empty-state without a 404 round-trip.
    Graph backends without parity (NullGraphStore, NebulaStore until
    they implement ``get_wiki_graph``) also return the empty shape so
    the route stays available across deployments.
    """
    await assert_channel_access(principal, channel_id)
    stores = get_stores()
    graph = stores.graph
    if not hasattr(graph, "get_wiki_graph"):
        return {"channel_id": channel_id, "nodes": [], "edges": []}
    try:
        payload = await graph.get_wiki_graph(channel_id)
    except Exception as exc:  # noqa: BLE001 — soft-fail to empty graph
        logger.exception(
            "event=wiki_graph_query_failed channel_id=%s err=%s",
            channel_id,
            exc,
        )
        return {"channel_id": channel_id, "nodes": [], "edges": []}
    payload.setdefault("channel_id", channel_id)
    payload.setdefault("nodes", [])
    payload.setdefault("edges", [])
    return payload
