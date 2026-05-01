"""Retrieval tools: ask_channel, search_channel_facts, get_wiki_page,
get_recent_activity, search_media_references (Phase 3, tasks 3.4–3.5)."""

from __future__ import annotations

import logging
from typing import Annotated

from fastmcp import Context, FastMCP

from beever_atlas.api.mcp_server._helpers import (
    _get_principal_id,
    _validate_id,
)

logger = logging.getLogger(__name__)


def register_retrieval_tools(mcp: FastMCP) -> None:

    @mcp.tool(name="ask_channel", timeout=90.0)
    async def ask_channel(
        channel_id: Annotated[str, "The channel id to query (from list_channels)"],
        question: Annotated[str, "The natural-language question to answer"],
        ctx: Context,
        mode: Annotated[
            str,
            "QA mode: 'quick' (fast BM25), 'deep' (full ADK pipeline), or 'summarize'",
        ] = "deep",
        session_id: Annotated[
            str | None,
            "Session id for conversation continuity; defaults to a per-principal session",
        ] = None,
    ) -> dict:
        """Answer a natural-language question about a channel's knowledge base.

        This is the FLAGSHIP retrieval tool. It invokes the full ADK QA pipeline
        (embeddings + BM25 hybrid search + graph context + optional multi-hop
        reasoning) and returns a structured answer with citations.

        When to use: whenever the user asks a question about channel content,
        wants cited facts, or needs reasoning across multiple messages.
        Prefer ``search_channel_facts`` for exact keyword search without inference.

        mode options:
        - ``"quick"``: fast BM25-only retrieval, no ADK reasoning, ~3s
        - ``"deep"``: full ADK pipeline with graph context, ~20–60s (default)
        - ``"summarize"``: structured summary with wiki pages, ~10–30s

        The tool enforces a 90-second hard cap. On timeout, returns
        ``{error: "answer_timeout"}``. On channel access denial, returns
        ``{error: "channel_access_denied"}``.

        Returns: ``{answer, citations, follow_ups, metadata}``
        """
        principal_id = _get_principal_id(ctx)
        if not principal_id:
            logger.warning("event=mcp_tool_missing_principal tool=ask_channel")
            return {"error": "authentication_missing"}

        err = _validate_id(channel_id, "channel_id")
        if err:
            return err

        # Cost / availability guard: cap question length so a caller cannot
        # submit a megabyte prompt that burns the Gemini quota and holds a
        # 90s worker. 4KB is ample for natural-language questions.
        if not question or len(question) > 4000:
            return {
                "error": "invalid_parameter",
                "parameter": "question",
                "detail": "length must be 1..4000 characters",
            }

        try:
            from beever_atlas.infra.channel_access import assert_channel_access

            await assert_channel_access(principal_id, channel_id)
        except Exception as exc:
            from fastapi import HTTPException

            if isinstance(exc, HTTPException) and exc.status_code == 403:
                return {"error": "channel_access_denied", "channel_id": channel_id}
            # Any other exception surfaces as an adk_error — the caller sees a
            # structured dict rather than a protocol-level failure.
            logger.warning(
                "event=mcp_ask_channel_access_check_failed channel=%s err=%r",
                channel_id,
                exc,
            )
            return {"error": "channel_access_denied", "channel_id": channel_id}

        if mode not in {"quick", "summarize", "deep"}:
            return {
                "error": "invalid_parameter",
                "parameter": "mode",
                "detail": "mode must be one of: quick, summarize, deep",
            }

        import asyncio

        from beever_atlas.api.mcp_server._ask_runner import run_ask_channel

        try:
            return await run_ask_channel(
                principal_id=principal_id,
                channel_id=channel_id,
                question=question,
                mode=mode,
                session_id=session_id,
                ctx=ctx,
            )
        except asyncio.TimeoutError:
            logger.info(
                "event=mcp_ask_channel_timeout channel=%s principal=%s",
                channel_id,
                principal_id,
            )
            return {"error": "answer_timeout"}
        except Exception:
            # Never surface raw exception details to MCP clients — they may
            # contain internal hostnames, quota-project ids, or stack
            # fragments. Full traceback is in the server log instead.
            logger.exception(
                "event=mcp_ask_channel_runner_error channel=%s principal=%s",
                channel_id,
                principal_id,
            )
            return {"error": "adk_error"}

    @mcp.tool(name="search_channel_facts")
    async def search_channel_facts(
        channel_id: Annotated[str, "The channel id to search (from list_channels)"],
        query: Annotated[str, "Search query — BM25+vector hybrid over atomic facts"],
        ctx: Context,
        time_scope: Annotated[str, "'any' (all time) or 'recent' (last 30 days)"] = "any",
        limit: Annotated[int, "Maximum number of facts to return (1–50)"] = 10,
    ) -> dict:
        """Search atomic facts stored from a channel using BM25+vector hybrid retrieval.

        Each returned fact includes ``text``, ``author``, ``timestamp``,
        ``permalink``, ``channel_id``, ``confidence``, and ``topic_tags``.

        When to use: for targeted keyword or semantic search when you need
        specific facts with citations. Faster and more precise than ``ask_channel``
        for lookup queries. Use ``ask_channel`` when you need synthesized answers
        with reasoning across multiple facts.

        time_scope: ``"any"`` returns all facts; ``"recent"`` restricts to the
        last 30 days. Default: ``"any"``.

        Returns: ``{facts: [...]}`` or ``{error: "channel_access_denied", ...}``
        """
        principal_id = _get_principal_id(ctx)
        if not principal_id:
            return {"error": "authentication_missing"}

        err = _validate_id(channel_id, "channel_id")
        if err:
            return err

        # Fix #8: clamp to the documented 1–50 bound server-side so a
        # misbehaving client cannot burn retrieval cost with limit=999.
        limit = max(1, min(limit, 50))

        try:
            from beever_atlas.capabilities import memory as mem_cap
            from beever_atlas.capabilities.errors import ChannelAccessDenied

            facts = await mem_cap.search_channel_facts(
                principal_id,
                channel_id,
                query,
                time_scope=time_scope,
                limit=limit,
            )
            return {"facts": facts}
        except ChannelAccessDenied:
            return {"error": "channel_access_denied", "channel_id": channel_id}
        except Exception:
            logger.exception(
                "search_channel_facts: failed principal=%s channel_id=%s",
                principal_id,
                channel_id,
            )
            return {"facts": []}

    @mcp.tool(name="get_wiki_page")
    async def get_wiki_page(
        channel_id: Annotated[str, "The channel id (from list_channels)"],
        ctx: Context,
        page_type: Annotated[
            str,
            "Wiki page type: overview, faq, decisions, people, glossary, activity, topics",
        ] = "overview",
    ) -> dict:
        """Retrieve a pre-compiled wiki page for a channel.

        Wiki pages are generated offline during the sync pipeline and contain
        summarised, structured knowledge: ``overview`` (channel purpose and key
        topics), ``faq`` (common questions), ``decisions`` (key decisions made),
        ``people`` (active contributors), ``glossary`` (domain terms), and more.

        When to use: for quick structured summaries without invoking the full QA
        pipeline. Faster than ``ask_channel`` but less precise for specific
        queries. Use ``ask_channel`` when the wiki page doesn't have the answer.

        Returns the page dict verbatim (``page_type``, ``channel_id``,
        ``content``, ``summary``, ``text``), or ``null`` if the page has not
        been generated yet, or ``{error: "channel_access_denied"}`` on denial.
        """
        principal_id = _get_principal_id(ctx)
        if not principal_id:
            return {"error": "authentication_missing"}

        err = _validate_id(channel_id, "channel_id")
        if err:
            return err

        try:
            from beever_atlas.capabilities import wiki as wiki_cap
            from beever_atlas.capabilities.errors import ChannelAccessDenied

            page = await wiki_cap.get_wiki_page(principal_id, channel_id, page_type)
            return (
                page
                if page is not None
                else {
                    "page_type": page_type,
                    "channel_id": channel_id,
                    "content": None,
                }
            )
        except ChannelAccessDenied:
            return {"error": "channel_access_denied", "channel_id": channel_id}
        except Exception:
            logger.exception(
                "get_wiki_page: failed principal=%s channel_id=%s page_type=%s",
                principal_id,
                channel_id,
                page_type,
            )
            return {"page_type": page_type, "channel_id": channel_id, "content": None}

    @mcp.tool(name="get_recent_activity")
    async def get_recent_activity(
        channel_id: Annotated[str, "The channel id (from list_channels)"],
        ctx: Context,
        days: Annotated[int, "Look-back window in days (1–90)"] = 7,
        topic: Annotated[
            str | None,
            "Optional topic filter — narrows search to facts related to this topic",
        ] = None,
        limit: Annotated[int, "Maximum number of activity items to return (1–50)"] = 20,
    ) -> dict:
        """Return the most recent activity from a channel, optionally filtered by topic.

        Results are sorted by timestamp descending and include ``text``,
        ``author``, ``timestamp``, ``channel_id``, ``topic_tags``, and ``fact_id``.

        When to use: to answer "what has been discussed recently in #channel?"
        or "what happened with topic X in the last N days?" Use ``ask_channel``
        when you need reasoning or synthesis across multiple activity items.
        Use ``search_channel_facts`` for non-time-bounded search.

        Returns: ``{activity: [...]}`` or ``{error: "channel_access_denied", ...}``
        """
        principal_id = _get_principal_id(ctx)
        if not principal_id:
            return {"error": "authentication_missing"}

        err = _validate_id(channel_id, "channel_id")
        if err:
            return err

        # Fix #8: clamp to documented ranges.
        days = max(1, min(days, 90))
        limit = max(1, min(limit, 50))

        try:
            from beever_atlas.capabilities import memory as mem_cap
            from beever_atlas.capabilities.errors import ChannelAccessDenied

            activity = await mem_cap.get_recent_activity(
                principal_id, channel_id, days=days, topic=topic, limit=limit
            )
            return {"activity": activity}
        except ChannelAccessDenied:
            return {"error": "channel_access_denied", "channel_id": channel_id}
        except Exception:
            logger.exception(
                "get_recent_activity: failed principal=%s channel_id=%s",
                principal_id,
                channel_id,
            )
            return {"activity": []}

    @mcp.tool(name="search_media_references")
    async def search_media_references(
        channel_id: Annotated[str, "The channel id (from list_channels)"],
        query: Annotated[str, "Search query for finding media-containing messages"],
        ctx: Context,
        media_type: Annotated[
            str | None,
            "Filter by media type: 'image', 'pdf', 'link', or null for all",
        ] = None,
        limit: Annotated[int, "Maximum number of results to return (1–20)"] = 5,
    ) -> dict:
        """Search for messages containing images, PDFs, or links shared in a channel.

        Each result includes ``text``, ``media_urls``, ``link_urls``,
        ``link_titles``, ``author``, ``timestamp``, ``media_type``, and
        ``fact_id``.

        When to use: when the user asks about documents, images, or links shared
        in a channel, or when you need to find a specific file or URL. Do NOT use
        for general knowledge search — use ``search_channel_facts`` for that.

        media_type: ``"image"`` (photos/screenshots), ``"pdf"`` (documents),
        ``"link"`` (URLs), or ``null`` (all types). Default: ``null``.

        Returns: ``{media: [...]}`` or ``{error: "channel_access_denied", ...}``
        """
        principal_id = _get_principal_id(ctx)
        if not principal_id:
            return {"error": "authentication_missing"}

        err = _validate_id(channel_id, "channel_id")
        if err:
            return err

        # Fix #8: clamp limit to documented 1–20 bound.
        limit = max(1, min(limit, 20))

        try:
            from beever_atlas.capabilities import memory as mem_cap
            from beever_atlas.capabilities.errors import ChannelAccessDenied

            media = await mem_cap.search_media_references(
                principal_id,
                channel_id,
                query,
                media_type=media_type,
                limit=limit,
            )
            return {"media": media}
        except ChannelAccessDenied:
            return {"error": "channel_access_denied", "channel_id": channel_id}
        except Exception:
            logger.exception(
                "search_media_references: failed principal=%s channel_id=%s",
                principal_id,
                channel_id,
            )
            return {"media": []}

    # -- search_memory ------------------------------------------------------
    @mcp.tool(name="search_memory")
    async def search_memory(
        query: Annotated[str, "Natural-language or keyword search query"],
        ctx: Context,
        scope: Annotated[
            str,
            "Either 'all' (default — search every channel the principal can access) "
            "or 'channel:<channel_id>' (search a single channel)",
        ] = "all",
        limit: Annotated[int, "Maximum hits across all channels (1–50)"] = 20,
    ) -> dict:
        """Cross-channel agent recall via Weaviate hybrid search.

        Use this when the agent does not yet know which channel holds the
        relevant memory — it merges hybrid (BM25 + vector) results from
        every channel the principal can access. Each hit carries
        ``fact_id``, ``text``, ``score``, ``channel_id``, ``cluster_id``,
        ``entity_tags``. Results are ranked by hybrid score across the
        merged set.

        scope:
          - ``"all"``: enumerate the principal's accessible channels and
            search each (auth-gated per channel). Use this when the agent
            does not yet know which channel holds the relevant memory.
          - ``"channel:<id>"``: single-channel search, equivalent to
            ``search_channel_facts`` but with the standard search_memory
            response shape.

        Returns: ``{hits: [...], query: <echo>}`` or
        ``{error: "channel_access_denied", channel_id: ...}`` for an
        explicit unreachable channel scope.
        """
        principal_id = _get_principal_id(ctx)
        if not principal_id:
            return {"error": "authentication_missing"}

        if not query or len(query) > 4000:
            return {
                "error": "invalid_parameter",
                "parameter": "query",
                "detail": "length must be 1..4000 characters",
            }

        # Clamp limit so a misbehaving caller cannot drain the whole
        # corpus through one call.
        limit = max(1, min(limit, 50))

        # Resolve scope → list of channel_ids to search.
        target_channels: list[str] = []
        if scope == "all":
            try:
                from beever_atlas.capabilities import connections as conn_cap
                from beever_atlas.stores import get_stores

                stores = get_stores()
                connections = await stores.platform.list_connections()
                visible_ids: set[str] = set()
                # Mirror ``connections.list_connections`` ownership semantics
                # so search_memory does not accidentally peek at other-tenant
                # channels: re-use the public capability rather than
                # re-implementing the rule.
                visible_conns = await conn_cap.list_connections(principal_id)
                visible_conn_ids = {row["connection_id"] for row in visible_conns}
                for conn in connections:
                    if conn.id not in visible_conn_ids:
                        continue
                    for cid in conn.selected_channels or []:
                        visible_ids.add(cid)
                target_channels = sorted(visible_ids)
            except Exception:
                logger.exception(
                    "search_memory: failed to enumerate channels for principal=%s",
                    principal_id,
                )
                return {"hits": [], "query": query}
        elif scope.startswith("channel:"):
            target_channels = [scope.split(":", 1)[1]]
        else:
            return {
                "error": "invalid_parameter",
                "parameter": "scope",
                "detail": "must be 'all' or 'channel:<id>'",
            }

        if not target_channels:
            return {"hits": [], "query": query}

        # Per-channel auth + hybrid search. We collect raw hits across
        # channels then re-rank by score before truncating to ``limit``.
        from beever_atlas.capabilities import memory as mem_cap
        from beever_atlas.capabilities.errors import ChannelAccessDenied

        explicit_scope = scope.startswith("channel:")
        merged: list[dict] = []
        per_channel_limit = max(5, limit)
        for cid in target_channels:
            try:
                facts = await mem_cap.search_channel_facts(
                    principal_id,
                    cid,
                    query,
                    time_scope="any",
                    limit=per_channel_limit,
                )
            except ChannelAccessDenied:
                if explicit_scope:
                    return {
                        "error": "channel_access_denied",
                        "channel_id": cid,
                    }
                continue
            except Exception:
                logger.warning("search_memory: per-channel search failed channel=%s", cid)
                continue
            for fact in facts:
                merged.append(
                    {
                        "fact_id": fact.get("fact_id") or fact.get("id"),
                        "text": fact.get("text") or fact.get("memory_text", ""),
                        "score": float(fact.get("score") or fact.get("confidence") or 0.0),
                        "channel_id": cid,
                        "cluster_id": fact.get("cluster_id"),
                        "entity_tags": list(fact.get("entity_tags") or []),
                    }
                )

        merged.sort(key=lambda h: h["score"], reverse=True)
        return {"hits": merged[:limit], "query": query}

    # -- lint_wiki ----------------------------------------------------------
    @mcp.tool(name="lint_wiki")
    async def lint_wiki(
        channel_id: Annotated[str, "The channel id whose wiki should be linted"],
        ctx: Context,
        target_lang: Annotated[
            str | None,
            "Language tag to lint (defaults to the channel's primary)",
        ] = None,
        run_coherence_check: Annotated[
            bool,
            "Run the bounded LLM coherence pass (one call per page)",
        ] = True,
    ) -> dict:
        """Run the wiki lint checks for a channel and return findings.

        Wraps the same ``POST /api/channels/{id}/wiki/lint`` HTTP endpoint
        used by the WikiHealthToolbar UI. Surfaces orphan pages, stale
        sections, duplicate sections, and intra-page coherence issues.
        Each finding carries ``severity``, ``category``, ``page_id``,
        ``section_id``, ``message``, and ``suggested_action``.

        Returns: ``{findings: [...], pages_scanned: N}`` or
        ``{error: "channel_access_denied", ...}``.
        """
        principal_id = _get_principal_id(ctx)
        if not principal_id:
            return {"error": "authentication_missing"}

        err = _validate_id(channel_id, "channel_id")
        if err:
            return err

        try:
            from beever_atlas.infra.channel_access import assert_channel_access
            from beever_atlas.services.wiki_lint import lint_channel_wiki
            from beever_atlas.stores import get_stores
            from beever_atlas.wiki.page_store import WikiPageStore

            await assert_channel_access(principal_id, channel_id)

            stores = get_stores()
            page_store = WikiPageStore(db=stores.mongodb.db)
            # Live cluster ids — orphan detection compares against the
            # channel's current TopicCluster set in Weaviate. Mirrors the
            # setup in api/wiki.py::lint_wiki so the MCP and HTTP paths
            # produce identical findings.
            live_cluster_ids: set[str] = set()
            try:
                clusters = await stores.weaviate.list_clusters(channel_id)
                live_cluster_ids = {str(getattr(c, "id", "") or "") for c in clusters}
            except Exception:  # noqa: BLE001
                logger.warning(
                    "lint_wiki MCP: live-cluster enumeration failed channel=%s — "
                    "orphan detection will skip",
                    channel_id,
                )

            report = await lint_channel_wiki(
                channel_id=channel_id,
                page_store=page_store,
                target_lang=target_lang or "en",
                live_cluster_ids=live_cluster_ids,
                run_coherence_check=run_coherence_check,
                llm_provider=None,
            )
            return report.model_dump(mode="json")
        except Exception as exc:
            # ``assert_channel_access`` raises a ``HTTPException(403)``
            # under-the-hood; surface that as channel_access_denied. Other
            # exceptions are swallowed with a structured log.
            from fastapi import HTTPException

            if isinstance(exc, HTTPException) and exc.status_code in (401, 403):
                return {"error": "channel_access_denied", "channel_id": channel_id}
            logger.exception(
                "lint_wiki: failed principal=%s channel_id=%s",
                principal_id,
                channel_id,
            )
            return {"findings": [], "error": "lint_failed"}

    # -- get_extraction_status ---------------------------------------------
    @mcp.tool(name="get_extraction_status")
    async def get_extraction_status(
        channel_id: Annotated[str, "The channel id whose extraction queue depth to return"],
        ctx: Context,
    ) -> dict:
        """Return per-status extraction counts for a channel.

        Backs operator + agent visibility into the background
        ExtractionWorker queue. Wraps the same ``GET
        /api/channels/{id}/extraction-status`` HTTP endpoint used by the
        Sync Progress + WikiTab UIs. Returns
        ``{channel_id, counts: {pending, extracting, done, failed}, total}``.
        """
        principal_id = _get_principal_id(ctx)
        if not principal_id:
            return {"error": "authentication_missing"}

        err = _validate_id(channel_id, "channel_id")
        if err:
            return err

        try:
            from beever_atlas.infra.channel_access import assert_channel_access
            from beever_atlas.stores import get_stores

            await assert_channel_access(principal_id, channel_id)
            stores = get_stores()
            counts = await stores.mongodb.count_channel_messages_by_status(channel_id)
            total = sum(counts.values())
            return {
                "channel_id": channel_id,
                "counts": counts,
                "total": total,
            }
        except Exception as exc:
            from fastapi import HTTPException

            if isinstance(exc, HTTPException) and exc.status_code in (401, 403):
                return {"error": "channel_access_denied", "channel_id": channel_id}
            logger.exception(
                "get_extraction_status: failed principal=%s channel_id=%s",
                principal_id,
                channel_id,
            )
            return {"error": "extraction_status_failed"}
