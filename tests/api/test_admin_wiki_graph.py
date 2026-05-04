"""Tests for the wiki-graph endpoint + Neo4j formatter (§6.3–§6.5).

Covers:
  - §6.3: empty channel returns empty arrays with HTTP 200
  - §6.4: 5 pages + 7 cross-links → 5 wiki nodes + 7 references_wiki edges
  - §6.5: entity cross-edges have data.kind="references_entity"
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock


# ---------------------------------------------------------------------------
# Neo4j fake — captures driver session + query/record shape
# ---------------------------------------------------------------------------


class _FakeRecord:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __getitem__(self, key: str) -> Any:
        return self._data.get(key)


class _FakeResult:
    def __init__(self, records: list[dict[str, Any]]) -> None:
        self._records = [_FakeRecord(r) for r in records]

    def __aiter__(self):
        return self

    async def __anext__(self) -> _FakeRecord:
        if not self._records:
            raise StopAsyncIteration
        return self._records.pop(0)


class _FakeSession:
    """Records every query and returns canned results matched by substring."""

    def __init__(self, page_records, edge_records, entity_records) -> None:
        self._page_records = page_records
        self._edge_records = edge_records
        self._entity_records = entity_records
        self.queries: list[str] = []

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *args, **kwargs) -> None:
        return None

    async def run(self, query: str, **params) -> _FakeResult:
        self.queries.append(query)
        # Dispatch by query content — order matters: REFERENCES before
        # Entity because the entity query does not contain REFERENCES
        # but does contain WikiPage; the references query contains both
        # WikiPage AND REFERENCES.
        if "REFERENCES" in query:
            return _FakeResult(self._edge_records)
        if "Entity" in query:
            return _FakeResult(self._entity_records)
        # Default: the WikiPage-node query.
        return _FakeResult(self._page_records)


class _FakeDriver:
    def __init__(self, session: _FakeSession) -> None:
        self._session = session

    def session(self) -> _FakeSession:
        return self._session


def _make_neo4j_store(session: _FakeSession):
    from beever_atlas.stores.neo4j_store import Neo4jStore

    store = Neo4jStore.__new__(Neo4jStore)
    store._driver = _FakeDriver(session)  # type: ignore[attr-defined]
    return store


# ---------------------------------------------------------------------------
# §6.3 — empty channel
# ---------------------------------------------------------------------------


async def test_get_wiki_graph_empty_channel_returns_empty_arrays() -> None:
    session = _FakeSession(page_records=[], edge_records=[], entity_records=[])
    store = _make_neo4j_store(session)
    payload = await store.get_wiki_graph("C1")
    assert payload["channel_id"] == "C1"
    assert payload["nodes"] == []
    assert payload["edges"] == []


# ---------------------------------------------------------------------------
# §6.4 — 5 pages + 7 cross-links
# ---------------------------------------------------------------------------


async def test_get_wiki_graph_returns_pages_and_references_edges() -> None:
    pages = [
        {
            "slug": f"topic-{i}",
            "title": f"Topic {i}",
            "kind": "topic",
            "version": i,
            "last_updated": "2026-05-01T00:00:00Z",
        }
        for i in range(1, 6)
    ]
    # 7 references_wiki edges spanning the five nodes (a tiny DAG).
    raw_edges = [
        ("topic-1", "topic-2"),
        ("topic-1", "topic-3"),
        ("topic-2", "topic-4"),
        ("topic-2", "topic-5"),
        ("topic-3", "topic-4"),
        ("topic-4", "topic-5"),
        ("topic-5", "topic-1"),
    ]
    edges = [{"src_slug": s, "dst_slug": d} for s, d in raw_edges]
    session = _FakeSession(page_records=pages, edge_records=edges, entity_records=[])
    store = _make_neo4j_store(session)

    payload = await store.get_wiki_graph("C1")
    assert len(payload["nodes"]) == 5
    assert {n["data"]["id"] for n in payload["nodes"]} == {
        "topic-1",
        "topic-2",
        "topic-3",
        "topic-4",
        "topic-5",
    }
    # All wiki nodes carry kind="wiki" and the page_kind from Neo4j.
    for node in payload["nodes"]:
        assert node["data"]["kind"] == "wiki"
        assert node["data"]["page_kind"] == "topic"

    assert len(payload["edges"]) == 7
    edge_pairs = {(e["data"]["source"], e["data"]["target"]) for e in payload["edges"]}
    assert edge_pairs == set(raw_edges)
    # All references_wiki edges carry the right kind tag.
    for edge in payload["edges"]:
        assert edge["data"]["kind"] == "references_wiki"
        assert edge["data"]["id"].startswith("e:")


async def test_get_wiki_graph_dedupes_repeated_edges() -> None:
    """Defensive — Neo4j MERGE prevents duplicate edges, but the
    formatter must not double-emit the same pair if the underlying
    query ever returns it twice."""
    pages = [{"slug": "a", "title": "A", "kind": "topic", "version": 1, "last_updated": ""}]
    edges = [
        {"src_slug": "a", "dst_slug": "a"},
        {"src_slug": "a", "dst_slug": "a"},
    ]
    session = _FakeSession(page_records=pages, edge_records=edges, entity_records=[])
    store = _make_neo4j_store(session)
    payload = await store.get_wiki_graph("C1")
    assert len(payload["edges"]) == 1


# ---------------------------------------------------------------------------
# §6.5 — entity cross-edges carry data.kind="references_entity"
# ---------------------------------------------------------------------------


async def test_entity_cross_edges_emit_references_entity_kind() -> None:
    pages = [
        {
            "slug": "topic-auth",
            "title": "Authentication",
            "kind": "topic",
            "version": 3,
            "last_updated": "2026-05-01",
        }
    ]
    entity_rows = [
        {
            "src_slug": "topic-auth",
            "entity_name": "Alice",
            "entity_type": "Person",
        }
    ]
    session = _FakeSession(page_records=pages, edge_records=[], entity_records=entity_rows)
    store = _make_neo4j_store(session)
    payload = await store.get_wiki_graph("C1")

    # 1 wiki node + 1 entity node = 2.
    assert len(payload["nodes"]) == 2
    entity_nodes = [n for n in payload["nodes"] if n["data"]["kind"] == "entity"]
    assert len(entity_nodes) == 1
    assert entity_nodes[0]["data"]["id"] == "entity:Alice"
    assert entity_nodes[0]["data"]["entity_type"] == "Person"

    # 1 references_entity edge.
    assert len(payload["edges"]) == 1
    edge = payload["edges"][0]
    assert edge["data"]["kind"] == "references_entity"
    assert edge["data"]["source"] == "topic-auth"
    assert edge["data"]["target"] == "entity:Alice"


# ---------------------------------------------------------------------------
# Endpoint behaviour — graceful degradation
# ---------------------------------------------------------------------------


async def test_endpoint_falls_back_to_empty_graph_when_backend_lacks_method() -> None:
    """When stores.graph is a NullGraphStore / older NebulaStore that
    doesn't expose ``get_wiki_graph``, the endpoint still returns 200
    with empty arrays so the frontend route can render."""
    from beever_atlas.api.wiki import get_wiki_graph

    class _BareGraph:
        pass

    fake_stores = type("S", (), {"graph": _BareGraph()})()
    principal = type("P", (), {"id": "u-1"})()

    from unittest.mock import patch

    async def _ok(*args, **kwargs):
        return None

    with (
        patch("beever_atlas.api.wiki.get_stores", return_value=fake_stores),
        patch(
            "beever_atlas.infra.channel_access.assert_channel_access",
            new=AsyncMock(side_effect=_ok),
        ),
    ):
        result = await get_wiki_graph("C1", principal=principal)
    assert result == {"channel_id": "C1", "nodes": [], "edges": []}


async def test_endpoint_swallows_neo4j_errors_with_empty_payload() -> None:
    """A live Neo4j hiccup must not 500 the wiki graph route — the
    operator's view of the wiki should not depend on a graph backend
    being healthy."""
    from beever_atlas.api.wiki import get_wiki_graph

    class _BoomGraph:
        async def get_wiki_graph(self, channel_id):
            raise RuntimeError("neo down")

    fake_stores = type("S", (), {"graph": _BoomGraph()})()
    principal = type("P", (), {"id": "u-1"})()

    from unittest.mock import patch

    async def _ok(*args, **kwargs):
        return None

    with (
        patch("beever_atlas.api.wiki.get_stores", return_value=fake_stores),
        patch(
            "beever_atlas.infra.channel_access.assert_channel_access",
            new=AsyncMock(side_effect=_ok),
        ),
    ):
        result = await get_wiki_graph("C1", principal=principal)
    assert result["nodes"] == []
    assert result["edges"] == []
