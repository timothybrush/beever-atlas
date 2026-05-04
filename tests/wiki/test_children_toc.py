"""Tests for the <<CHILDREN_TOC>> marker rendering used by folder pages."""

from __future__ import annotations

from beever_atlas.wiki.render import (
    CHILDREN_TOC_MARKER,
    apply_children_toc_marker,
    render_children_toc,
)


def test_render_children_toc_basic() -> None:
    """A list of children renders as Markdown bullets with links."""
    rendered = render_children_toc(
        [
            {"title": "Auth", "slug": "topic-auth"},
            {"title": "RBAC", "slug": "topic-rbac"},
        ]
    )
    assert rendered.splitlines() == [
        "- [Auth](/wiki/topic-auth)",
        "- [RBAC](/wiki/topic-rbac)",
    ]


def test_render_children_toc_with_summary() -> None:
    """Summaries are appended after an em-dash, truncated to 140 chars."""
    long_summary = "x" * 200
    rendered = render_children_toc(
        [{"title": "T", "slug": "t", "summary": long_summary}]
    )
    assert rendered.startswith("- [T](/wiki/t) — ")
    # Truncated content followed by ellipsis sentinel.
    assert rendered.endswith("…")


def test_render_children_toc_handles_missing_slug() -> None:
    """When slug is missing, render the title as plain text (no link)."""
    rendered = render_children_toc([{"title": "Plain"}])
    assert rendered == "- Plain"


def test_render_children_toc_empty() -> None:
    assert render_children_toc([]) == ""


def test_apply_marker_replaces_inline() -> None:
    """Marker in the middle of content is replaced with the rendered TOC."""
    content = (
        "## Intro\nSome prose.\n\n"
        + CHILDREN_TOC_MARKER
        + "\n\n## Threads\nSome more prose."
    )
    out = apply_children_toc_marker(
        content, [{"title": "A", "slug": "a"}, {"title": "B", "slug": "b"}]
    )
    assert "- [A](/wiki/a)" in out
    assert "- [B](/wiki/b)" in out
    assert CHILDREN_TOC_MARKER not in out
    assert "## Threads" in out


def test_apply_marker_appends_fallback_when_marker_missing() -> None:
    """If the LLM forgot the marker, append a default section at the end."""
    content = "## Intro\nProse without a marker."
    out = apply_children_toc_marker(content, [{"title": "A", "slug": "a"}])
    assert out.startswith("## Intro\nProse without a marker.")
    assert "## Pages in this folder" in out
    assert "- [A](/wiki/a)" in out


def test_apply_marker_strips_marker_line_when_no_children() -> None:
    """Marker line dropped when children is empty (no useless heading)."""
    content = (
        "## Intro\n\n"
        + CHILDREN_TOC_MARKER
        + "\n\n## After"
    )
    out = apply_children_toc_marker(content, [])
    assert CHILDREN_TOC_MARKER not in out
    assert "## After" in out
    # No fallback heading either.
    assert "## Pages in this folder" not in out


def test_apply_marker_no_op_when_no_marker_no_children() -> None:
    """Empty children + no marker is a no-op."""
    content = "## Intro\nProse."
    assert apply_children_toc_marker(content, []) == content
