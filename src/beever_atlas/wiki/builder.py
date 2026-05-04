"""WikiBuilder orchestrates the gather → compile → cache pipeline."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import UTC, datetime
from typing import Any

from beever_atlas.llm import get_llm_provider
from beever_atlas.models.domain import WikiMetadata, WikiResponse
from beever_atlas.wiki.compiler import WikiCompiler
from beever_atlas.wiki.data_gatherer import WikiDataGatherer

logger = logging.getLogger(__name__)


# Module-level per-channel lock registry. Because the API layer constructs a
# fresh WikiBuilder per request, instance-level locks cannot serialize
# concurrent generations. These module-level structures survive across
# WikiBuilder instances and ensure only one generation runs per channel at a
# time (regardless of target_lang).
def _detect_platform(channel_id: str) -> str:
    """Infer platform from channel_id format.

    Mirrors ``beever_atlas.api.channels._detect_platform_from_channel_id``
    but is duplicated here to avoid a wiki→api import cycle. Falls back to
    ``"unknown"`` rather than hardcoding ``"slack"``.
    """
    if re.match(r"^[CDG][A-Z0-9]{8,}$", channel_id):
        return "slack"
    if re.match(r"^\d{17,20}$", channel_id):
        return "discord"
    return "unknown"


_CHANNEL_LOCKS: dict[str, asyncio.Lock] = {}
_CHANNEL_LOCKS_GUARD = asyncio.Lock()
_ACTIVE_GENERATIONS: set[str] = set()


async def _get_channel_lock(channel_id: str) -> asyncio.Lock:
    async with _CHANNEL_LOCKS_GUARD:
        lock = _CHANNEL_LOCKS.get(channel_id)
        if lock is None:
            lock = asyncio.Lock()
            _CHANNEL_LOCKS[channel_id] = lock
        return lock


class WikiBuilder:
    """Orchestrates the three-phase wiki generation pipeline."""

    def __init__(self, weaviate_store, graph_store, wiki_cache) -> None:
        self._gatherer = WikiDataGatherer(weaviate_store, graph_store)
        # Compiler is recreated per-request to carry target_lang/source_lang.
        self._gatherer_bound = True
        self._cache = wiki_cache

    def _make_compiler(self, target_lang: str, source_lang: str) -> WikiCompiler:
        return WikiCompiler(target_lang=target_lang, source_lang=source_lang)

    async def generate_wiki(
        self,
        channel_id: str,
        *,
        target_lang: str | None = None,
        source_lang: str | None = None,
    ) -> WikiResponse:
        """Full pipeline: gather → compile → cache. Returns the WikiResponse.

        Args:
            channel_id: Channel to generate for.
            target_lang: BCP-47 tag for the rendered output. Defaults to
                settings.default_target_language when None.
            source_lang: BCP-47 tag of the underlying memory. When None, the
                builder will look it up from the channel's sync state (falling
                back to "en" for channels that predate language detection).
        """
        # Resolve languages.
        from beever_atlas.infra.config import get_settings as _get_settings

        _settings = _get_settings()
        if target_lang is None:
            target_lang = _settings.default_target_language or "en"
        resolved_source_lang: str = "en"
        if source_lang is not None:
            resolved_source_lang = source_lang
        else:
            # Try to read the channel's primary_language from sync state.
            try:
                from beever_atlas.stores import get_stores as _gs

                _state = await _gs().mongodb.get_channel_sync_state(channel_id)
                if _state is not None:
                    resolved_source_lang = getattr(_state, "primary_language", "en") or "en"
            except Exception:  # noqa: BLE001
                pass
        source_lang = resolved_source_lang

        # Serialize generations per-channel via module-level lock (API layer
        # creates a fresh WikiBuilder per request, so instance locks won't
        # serialize concurrent requests). One run at a time per channel,
        # regardless of target_lang.
        channel_lock = await _get_channel_lock(channel_id)
        async with channel_lock:
            return await self._generate_wiki_locked(
                channel_id=channel_id,
                target_lang=target_lang,
                source_lang=source_lang,
            )

    async def _generate_wiki_locked(
        self,
        *,
        channel_id: str,
        target_lang: str,
        source_lang: str,
    ) -> WikiResponse:
        _ACTIVE_GENERATIONS.add(channel_id)
        compiler = self._make_compiler(target_lang=target_lang, source_lang=source_lang)
        model_name = get_llm_provider().get_model_string("wiki_compiler")

        try:
            start = time.monotonic()

            # Phase 1: gather
            await self._cache.set_generation_status(
                channel_id=channel_id,
                status="running",
                stage="gathering",
                stage_detail="Fetching memories, entities, and topics from stores",
                model=model_name,
                target_lang=target_lang,
            )
            data = await self._gatherer.gather(channel_id)

            # Phase 2: compile (with progress tracking)
            clusters = data.get("clusters", [])
            # Match compiler's conditional fixed-page plan so progress totals stay accurate.
            total_faq = sum(len(c.faq_candidates) for c in clusters)
            has_decisions = len(data.get("decisions", [])) > 0
            has_faq = total_faq > 0
            has_glossary = len((data["channel_summary"].glossary_terms or [])) > 0
            has_resources = any(
                (fact.source_media_urls or fact.source_link_urls)
                for fact in data.get("media_facts", [])
            )
            fixed_pages_total = (
                3  # overview, people, activity (always generated)
                + (1 if has_decisions else 0)
                + (1 if has_faq else 0)
                + (1 if has_glossary else 0)
                + (1 if has_resources else 0)
            )
            total_pages = fixed_pages_total + len(clusters)

            await self._cache.set_generation_status(
                channel_id=channel_id,
                status="running",
                stage="compiling",
                stage_detail="Starting page compilation",
                pages_total=total_pages,
                pages_done=0,
                pages_completed=[],
                model=model_name,
                target_lang=target_lang,
            )

            async def on_page_compiled(
                page_id: str, pages_done: int, pages_completed: list[str]
            ) -> None:
                await self._cache.set_generation_status(
                    channel_id=channel_id,
                    status="running",
                    stage="compiling",
                    stage_detail=f"Compiled {page_id}",
                    pages_total=total_pages,
                    pages_done=pages_done,
                    pages_completed=pages_completed,
                    model=model_name,
                    target_lang=target_lang,
                )

            pages = await compiler.compile(data, on_page_compiled=on_page_compiled)

            # Phase 3: assemble & save
            await self._cache.set_generation_status(
                channel_id=channel_id,
                status="running",
                stage="saving",
                stage_detail="Saving wiki to cache",
                pages_total=total_pages,
                pages_done=len(pages),
                pages_completed=list(pages.keys()),
                model=model_name,
                target_lang=target_lang,
            )

            channel_summary = data["channel_summary"]
            platform = _detect_platform(channel_id)
            structure = compiler.build_structure(
                channel_id=channel_id,
                channel_name=channel_summary.channel_name,
                platform=platform,
                pages=pages,
            )

            # ``llm-wiki-folder-structure`` Phase C — optional folder
            # plan + folder index synthesis layered on top of the
            # already-built flat structure. Runs only when the
            # ``WIKI_FOLDER_PLANNER`` flag is ON AND the channel has
            # enough topics to warrant folders. Failures (planner
            # falls back to flat, no folders produced) silently
            # leave the structure unchanged.
            try:
                from beever_atlas.infra.config import get_settings as _gs2
                from beever_atlas.wiki.structure import WikiStructurePlanner

                _settings2 = _gs2()
                if _settings2.wiki_folder_planner:
                    cluster_dicts: list[dict] = []
                    for c in clusters:
                        cluster_dicts.append(
                            {
                                "id": getattr(c, "id", "") or "",
                                "title": getattr(c, "title", "") or "",
                                "summary": getattr(c, "summary", "") or "",
                                "member_count": getattr(c, "member_count", 0) or 0,
                                "key_entities": [
                                    e.model_dump() if hasattr(e, "model_dump") else e
                                    for e in (getattr(c, "key_entities", []) or [])
                                ],
                            }
                        )

                    # Use the compiler's existing async LLM helper as
                    # the planner's injected callable. This piggy-backs
                    # on the compiler's retry/parsing/safety logic and
                    # avoids re-implementing provider invocation.
                    async def _llm_call(prompt: str) -> str:
                        return await compiler._llm_generate_json(  # type: ignore[attr-defined]
                            prompt, temperature=0.2, page_kind="topic"
                        )

                    planner = WikiStructurePlanner(
                        llm=_llm_call,
                        min_topics_for_folders=_settings2.wiki_min_topics_for_folders,
                    )
                    plan = await planner.plan_async(
                        channel_summary=getattr(channel_summary, "summary", "")
                        or getattr(channel_summary, "description", "")
                        or "",
                        clusters=cluster_dicts,
                        fact_graph=None,
                    )
                    logger.info(
                        "wiki_folder_planner_result channel=%s folders=%d "
                        "leaves=%d fallback=%s",
                        channel_id,
                        len(plan.folders),
                        len(plan.leaves),
                        plan.fallback_reason or "ok",
                    )

                    if plan.folders:
                        # Build a slug → page lookup so compile_folders
                        # can find the leaves to feed into FOLDER_INDEX_PROMPT.
                        leaves_by_slug: dict[str, Any] = {}
                        for p in pages.values():
                            if getattr(p, "slug", None):
                                leaves_by_slug[p.slug] = p
                        folder_pages = await compiler.compile_folders(
                            plan=plan, leaves_by_slug=leaves_by_slug
                        )
                        # Add folder pages to the page dict so they
                        # round-trip through the cache.
                        for fp_id, fp in folder_pages.items():
                            pages[fp_id] = fp
                        # Re-shape the structure to put folders at root
                        # with their leaves nested inside.
                        structure = compiler.apply_folder_plan_to_structure(
                            structure,
                            plan=plan,
                            folder_pages=folder_pages,
                        )
            except Exception:  # noqa: BLE001 — planner is best-effort
                logger.exception(
                    "wiki_folder_planner_unhandled channel=%s — falling back "
                    "to flat structure",
                    channel_id,
                )

            duration_ms = int((time.monotonic() - start) * 1000)
            overview = pages.get("overview")
            if overview is None:
                raise RuntimeError("overview page compilation failed")

            metadata = WikiMetadata(
                memory_count=data["total_facts"],
                entity_count=data["total_entities"],
                media_count=channel_summary.media_count,
                page_count=len(pages),
                generation_duration_ms=duration_ms,
            )

            now = datetime.now(tz=UTC)
            wiki = WikiResponse(
                channel_id=channel_id,
                channel_name=channel_summary.channel_name,
                platform=platform,
                generated_at=now,
                is_stale=False,
                structure=structure,
                overview=overview,
                metadata=metadata,
            )

            wiki_dict = wiki.model_dump(mode="json")
            # Flatten pages into the cache doc
            wiki_dict["pages"] = {p_id: p.model_dump(mode="json") for p_id, p in pages.items()}

            await self._cache.save_wiki(channel_id, wiki_dict, target_lang=target_lang)

            # Mark generation complete
            await self._cache.set_generation_status(
                channel_id=channel_id,
                status="done",
                stage="done",
                stage_detail=f"Generated {len(pages)} pages in {duration_ms / 1000:.1f}s",
                pages_total=len(pages),
                pages_done=len(pages),
                pages_completed=list(pages.keys()),
                model=model_name,
                target_lang=target_lang,
            )

            logger.info(
                "WikiBuilder: generated wiki channel=%s pages=%d duration_ms=%d",
                channel_id,
                len(pages),
                duration_ms,
            )
            return wiki

        except Exception as exc:
            await self._cache.set_generation_status(
                channel_id=channel_id,
                status="failed",
                stage="error",
                stage_detail=str(exc)[:200],
                model=model_name,
                error=str(exc)[:500],
                target_lang=target_lang,
            )
            raise

        finally:
            _ACTIVE_GENERATIONS.discard(channel_id)

    async def refresh_wiki(self, channel_id: str, *, target_lang: str | None = None) -> None:
        """Async wrapper for background generation.

        Serialized per-channel via module-level lock; concurrent invocations
        await rather than rejecting.
        """
        await self.generate_wiki(channel_id, target_lang=target_lang)
