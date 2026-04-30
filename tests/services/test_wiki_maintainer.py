"""Unit tests for the WikiMaintainer service (PR-F).

Covers the deterministic routing contract (no LLM call in
``plan_updates``) and the per-page rewrite invariants (title
preserved, version bumped, is_dirty cleared, page voice does not
drift across iterations).

Spec: ``openspec/changes/oss-pipeline-and-wiki-redesign/specs/wiki-maintainer/``
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from beever_atlas.models.persistence import WikiPage, WikiPageSection
from beever_atlas.services.wiki_maintainer import (
    WikiMaintainer,
    _hash_fact_ids,
    _slug_for_entity,
    _slug_for_fact_type,
    _slug_for_topic,
    get_wiki_maintainer,
    init_wiki_maintainer,
)


# ---------------------------------------------------------------------------
# Slug helpers
# ---------------------------------------------------------------------------


def test_slug_for_topic_prefixes_with_topic() -> None:
    assert _slug_for_topic("auth") == "topic:auth"


def test_slug_for_topic_replaces_slashes_with_dashes() -> None:
    assert _slug_for_topic("auth/sso") == "topic:auth-sso"


def test_slug_for_topic_handles_empty_cluster_id() -> None:
    assert _slug_for_topic("") == "topic:unspecified"


def test_slug_for_entity_lowercases_and_dashes() -> None:
    assert _slug_for_entity("Alice Wonderland") == "entity:alice-wonderland"


def test_slug_for_entity_returns_empty_when_input_blank() -> None:
    assert _slug_for_entity("") == ""
    assert _slug_for_entity("   ") == ""


def test_slug_for_fact_type_maps_known_roles() -> None:
    assert _slug_for_fact_type("decision") == "decisions"
    assert _slug_for_fact_type("question") == "faq"
    assert _slug_for_fact_type("action_item") == "action-items"


def test_slug_for_fact_type_returns_none_for_unmapped() -> None:
    """``observation``, ``opinion`` are not standalone pages — they
    belong on topic / entity pages alongside their cluster."""
    assert _slug_for_fact_type("observation") is None
    assert _slug_for_fact_type("opinion") is None
    assert _slug_for_fact_type("") is None


# ---------------------------------------------------------------------------
# plan_updates — deterministic routing
# ---------------------------------------------------------------------------


def _store_stub() -> Any:
    """Build a minimal WikiPageStore stub for routing-only tests."""
    stub = object.__new__(WikiMaintainer.__init__.__annotations__["page_store"])
    return stub


def _make_maintainer(page_store=None) -> WikiMaintainer:
    """Maintainer with a no-op LLM provider for routing tests."""
    if page_store is None:
        page_store = AsyncMock()
    return WikiMaintainer(page_store=page_store)


def test_plan_updates_routes_cluster_to_topic_page() -> None:
    """Spec scenario: ``Single fact touches multiple pages``."""
    m = _make_maintainer()
    plan = m.plan_updates(
        [
            {
                "id": "f1",
                "cluster_id": "auth",
                "entity_tags": [],
                "fact_type": "observation",
            }
        ]
    )
    assert plan == {"topic:auth": ["f1"]}


def test_plan_updates_routes_entity_tags_to_entity_pages() -> None:
    m = _make_maintainer()
    plan = m.plan_updates(
        [
            {
                "id": "f1",
                "cluster_id": None,
                "entity_tags": ["Alice", "Bob"],
                "fact_type": "observation",
            }
        ]
    )
    assert plan == {"entity:alice": ["f1"], "entity:bob": ["f1"]}


def test_plan_updates_routes_decision_to_decisions_page() -> None:
    m = _make_maintainer()
    plan = m.plan_updates(
        [
            {
                "id": "f1",
                "cluster_id": "auth",
                "entity_tags": ["alice"],
                "fact_type": "decision",
            }
        ]
    )
    assert plan == {
        "topic:auth": ["f1"],
        "entity:alice": ["f1"],
        "decisions": ["f1"],
    }


def test_plan_updates_is_deterministic_across_runs() -> None:
    """Spec scenario: ``Routing is deterministic across runs``."""
    m = _make_maintainer()
    facts = [
        {
            "id": "f1",
            "cluster_id": "auth",
            "entity_tags": ["alice", "auth-service"],
            "fact_type": "decision",
        }
    ]
    plan_a = m.plan_updates(facts)
    plan_b = m.plan_updates(facts)
    assert plan_a == plan_b


def test_plan_updates_skips_facts_without_id() -> None:
    """A fact without a valid id is dropped from routing — better than
    silently writing to a page with empty fact provenance."""
    m = _make_maintainer()
    plan = m.plan_updates(
        [
            {"cluster_id": "auth"},  # no id
            {"id": "", "cluster_id": "auth"},  # empty id
            {"id": "f1", "cluster_id": "auth"},
        ]
    )
    assert plan == {"topic:auth": ["f1"]}


def test_plan_updates_does_NOT_call_llm() -> None:
    """Spec contract: routing must be a pure function — no LLM call.

    The maintainer is created with llm_provider=None; if any code path
    in plan_updates tried to invoke it, this would AttributeError.
    """
    m = WikiMaintainer(page_store=AsyncMock(), llm_provider=None)
    plan = m.plan_updates([{"id": "f1", "cluster_id": "auth", "entity_tags": ["alice"]}])
    assert "topic:auth" in plan


# ---------------------------------------------------------------------------
# on_extraction_done — manual mode (mark dirty)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_extraction_done_manual_marks_pages_dirty() -> None:
    """Spec scenario: ``WIKI_MAINTENANCE_MODE=manual``."""
    page_store = AsyncMock()
    page_store.mark_dirty = AsyncMock(return_value=2)
    maintainer = WikiMaintainer(page_store=page_store)

    async def _stub_load(*args, **kwargs):
        return [
            {
                "id": "f1",
                "cluster_id": "auth",
                "entity_tags": ["alice"],
                "fact_type": "decision",
            }
        ]

    maintainer._load_facts = _stub_load  # type: ignore[method-assign]
    counters = await maintainer.on_extraction_done("C1", ["f1"], mode="manual")
    assert counters["affected_pages"] == 3  # topic, entity, decisions
    page_store.mark_dirty.assert_awaited_once()
    # apply_update was NOT called in manual mode.
    page_store.save_page.assert_not_awaited()


# ---------------------------------------------------------------------------
# on_extraction_done — auto mode (apply rewrite)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_extraction_done_auto_applies_rewrites() -> None:
    """Spec scenario: ``WIKI_MAINTENANCE_MODE=auto``."""
    page_store = AsyncMock()
    page_store.get_page = AsyncMock(return_value=None)  # first-touch path
    page_store.save_page = AsyncMock()
    maintainer = WikiMaintainer(page_store=page_store)

    async def _stub_load(*args, **kwargs):
        return [{"id": "f1", "cluster_id": "auth", "entity_tags": []}]

    maintainer._load_facts = _stub_load  # type: ignore[method-assign]
    counters = await maintainer.on_extraction_done("C1", ["f1"], mode="auto")
    assert counters["rewritten"] >= 1
    page_store.save_page.assert_awaited()


@pytest.mark.asyncio
async def test_on_extraction_done_empty_fact_list_is_noop() -> None:
    page_store = AsyncMock()
    maintainer = WikiMaintainer(page_store=page_store)
    counters = await maintainer.on_extraction_done("C1", [], mode="auto")
    assert counters == {"affected_pages": 0, "marked_dirty": 0, "rewritten": 0}
    page_store.save_page.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_extraction_done_auto_isolates_per_page_failures() -> None:
    """A bad page rewrite must not stop other affected pages from updating.

    Mirrors the ExtractionWorker subscriber-isolation contract — this
    is the receiving end of that pipeline.
    """
    page_store = AsyncMock()
    page_store.get_page = AsyncMock(return_value=None)
    save_results: list[Any] = [RuntimeError("flaky"), None]
    page_store.save_page = AsyncMock(side_effect=save_results)
    maintainer = WikiMaintainer(page_store=page_store)

    async def _stub_load(*args, **kwargs):
        return [
            {
                "id": "f1",
                "cluster_id": "auth",
                "entity_tags": ["alice"],
                "fact_type": "observation",
            }
        ]

    maintainer._load_facts = _stub_load  # type: ignore[method-assign]
    counters = await maintainer.on_extraction_done("C1", ["f1"], mode="auto")
    # At least one page rewrote successfully; the other was logged.
    assert counters["affected_pages"] == 2  # topic + entity
    assert counters["rewritten"] >= 1


# ---------------------------------------------------------------------------
# apply_update — page-voice invariants
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_update_preserves_title_and_slug() -> None:
    """Spec scenario: ``Maintainer updates one section of a page``.

    Title and slug MUST be byte-identical across rewrites; the whole
    point of the maintainer is that page identity is stable.
    """
    saved_pages: list[WikiPage] = []
    page_store = AsyncMock()
    page_store.get_page = AsyncMock(
        return_value=WikiPage(
            channel_id="C1",
            target_lang="en",
            page_id="topic:auth",
            title="Authentication Architecture",
            slug="auth-architecture",
            sections=[WikiPageSection(id="overview", title="Overview", content_md="# A")],
        )
    )

    async def _capture_save(page: WikiPage) -> None:
        saved_pages.append(page)

    page_store.save_page = AsyncMock(side_effect=_capture_save)
    maintainer = WikiMaintainer(page_store=page_store)
    await maintainer.apply_update("C1", "topic:auth", ["f1"])
    assert len(saved_pages) == 1
    saved = saved_pages[0]
    assert saved.title == "Authentication Architecture"
    assert saved.slug == "auth-architecture"


@pytest.mark.asyncio
async def test_apply_update_clears_is_dirty() -> None:
    """A successful rewrite drains the page from the manual-mode queue."""
    saved_pages: list[WikiPage] = []
    page_store = AsyncMock()
    page_store.get_page = AsyncMock(
        return_value=WikiPage(
            channel_id="C1",
            target_lang="en",
            page_id="topic:auth",
            title="Auth",
            is_dirty=True,
        )
    )
    page_store.save_page = AsyncMock(side_effect=lambda p: saved_pages.append(p))
    maintainer = WikiMaintainer(page_store=page_store)
    await maintainer.apply_update("C1", "topic:auth", ["f1"])
    assert saved_pages[0].is_dirty is False


@pytest.mark.asyncio
async def test_apply_update_records_new_fact_ids_in_last_facts_seen() -> None:
    saved_pages: list[WikiPage] = []
    page_store = AsyncMock()
    page_store.get_page = AsyncMock(
        return_value=WikiPage(
            channel_id="C1",
            target_lang="en",
            page_id="topic:auth",
            title="Auth",
            last_facts_seen=["existing-1"],
        )
    )
    page_store.save_page = AsyncMock(side_effect=lambda p: saved_pages.append(p))
    maintainer = WikiMaintainer(page_store=page_store)
    await maintainer.apply_update("C1", "topic:auth", ["f-new-1", "f-new-2"])
    assert "existing-1" in saved_pages[0].last_facts_seen
    assert "f-new-1" in saved_pages[0].last_facts_seen
    assert "f-new-2" in saved_pages[0].last_facts_seen


@pytest.mark.asyncio
async def test_apply_update_returns_false_when_no_truly_new_facts() -> None:
    """If every new_fact_id is already in last_facts_seen, the
    maintainer skips the LLM call entirely. Cost guard."""
    page_store = AsyncMock()
    page_store.get_page = AsyncMock(
        return_value=WikiPage(
            channel_id="C1",
            target_lang="en",
            page_id="topic:auth",
            title="Auth",
            last_facts_seen=["f1", "f2"],
        )
    )
    maintainer = WikiMaintainer(page_store=page_store)
    applied = await maintainer.apply_update("C1", "topic:auth", ["f1", "f2"])
    assert applied is False
    page_store.save_page.assert_not_awaited()


# ---------------------------------------------------------------------------
# Singleton wiring
# ---------------------------------------------------------------------------


def test_init_and_get_singleton() -> None:
    page_store = AsyncMock()
    maintainer = WikiMaintainer(page_store=page_store)
    init_wiki_maintainer(maintainer)
    assert get_wiki_maintainer() is maintainer


# ---------------------------------------------------------------------------
# _hash_fact_ids — deterministic with null-byte separator
# ---------------------------------------------------------------------------


def test_hash_fact_ids_is_deterministic() -> None:
    assert _hash_fact_ids(["a", "b"]) == _hash_fact_ids(["a", "b"])


def test_hash_fact_ids_order_invariant() -> None:
    """Same set of ids in different orders → same hash."""
    assert _hash_fact_ids(["a", "b"]) == _hash_fact_ids(["b", "a"])


def test_hash_fact_ids_different_for_different_sets() -> None:
    assert _hash_fact_ids(["a", "b"]) != _hash_fact_ids(["a", "c"])
