"""Module-aware topic page orchestrator (single-call architecture).

One LLM call per topic page produces:
  - the module plan (which modules to render, in what order)
  - the TL;DR sentence
  - the Overview prose
  - the body markdown with module markers in place

The validator runs post-response and drops modules whose eligibility
predicates aren't satisfied (defensive against the LLM picking
modules whose data shape doesn't fit). Each surviving module is
rendered deterministically by its Python renderer; the marker
substitution pass splices the rendered content into the body.

Cost: 1 LLM call per topic page — same as today's monolithic
``TOPIC_PROMPT`` flow. Quality bet: structured plan + selection
rules force the model to think about page shape before writing.

Always returns a renderable result. Any failure (LLM, parse,
substitution) falls back to a minimum plan / empty content rather
than raising.
"""

from __future__ import annotations

import importlib
import inspect
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from beever_atlas.wiki.modules import LLMCallable, MODULE_CATALOG
from beever_atlas.wiki.modules.planner import (
    ModulePin,
    ModulePlan,
    _HUMAN_RULES,
    _validate_plan,
)
from beever_atlas.wiki.render import (
    ModuleSubstitutionError,
    substitute_module_markers,
)

logger = logging.getLogger(__name__)


@dataclass
class ModularPageOutput:
    """Final output the compiler persists.

    ``content`` is the assembled markdown (TL;DR + Overview prose +
    body with markers substituted). ``summary`` is a 1-2 sentence
    summary suitable for cards. ``modules`` is the persisted plan —
    feeds back into the maintainer for surgical patching.
    """

    content: str
    summary: str
    modules: list[dict[str, Any]] = field(default_factory=list)
    media_pins: list[ModulePin] = field(default_factory=list)
    # Telemetry — surfaces in compiler logs so soak runs can compare
    # cost/quality against the legacy single-prompt flow.
    planner_module_count: int = 0
    rendered_module_count: int = 0
    fell_back: bool = False


# ---------------------------------------------------------------------------
# Media data extractors — frontend-only modules consume structured
# media payloads from ``render_inputs["media"]`` rather than markdown.
# Each extractor pulls items that match its module's selector and
# normalises them to the shape the React renderer expects.
# ---------------------------------------------------------------------------


def _extract_media_for_module(
    module_id: str,
    render_inputs: dict[str, Any],
    media_pins: list[Any],
) -> dict[str, Any]:
    """Build the structured ``data`` payload for a frontend-only module.
    Returns a dict with module-specific keys; the React component
    reads it directly via ``module.data``.

    Most branches here build media payloads. Non-media frontend
    modules (e.g. ``key_facts`` v2) delegate to their own builders so
    each module's data shape stays close to its renderer.

    ``media_pins`` is the planner's ordered pin list (each item has
    ``media_id``, ``fact_id``, ``slot``). ``render_inputs["media"]``
    is the raw list of media records gathered from facts.

    Each module gets the slice it owns:
      - ``key_facts``     → severity-grouped card list (frontend v2)
      - ``hero_summary``  → tldr + summary + highlight counts
      - ``media_hero``    → one item (the hero candidate)
      - ``media_inline``  → all inline-pinned items + their fact_ids
      - ``media_gallery`` → unpinned image/video items
      - ``link_card``     → URL items not classified as image/video/pdf
      - ``pdf_preview``   → PDF items
      - ``video_embed``   → YouTube/Vimeo/native video items
    """
    # Non-media frontend modules — delegate to their per-module builder
    # so each module's data shape stays close to its renderer.
    if module_id == "key_facts":
        from beever_atlas.wiki.modules.key_facts import build_key_facts_data

        return build_key_facts_data(render_inputs.get("facts") or [])

    media = render_inputs.get("media") or []
    if not isinstance(media, list):
        media = []

    pinned_ids: set[str] = set()
    for pin in media_pins:
        mid = getattr(pin, "media_id", None)
        if mid:
            pinned_ids.add(str(mid))

    if module_id == "media_hero":
        for m in media:
            if not isinstance(m, dict):
                continue
            if m.get("is_hero") or m.get("hero_candidate"):
                return {
                    "label": "Hero",
                    "renderer_kind": "frontend",
                    "url": m.get("url", ""),
                    "alt": m.get("alt") or m.get("title") or "",
                    "caption": m.get("caption") or "",
                    "source_author": m.get("author") or "",
                    "source_date": m.get("date") or "",
                    "kind": (m.get("kind") or "image"),
                }
        return {"label": "Hero", "renderer_kind": "frontend", "url": "", "alt": ""}

    if module_id == "media_inline":
        items: list[dict] = []
        for pin in media_pins:
            if getattr(pin, "slot", "") != "inline":
                continue
            mid = getattr(pin, "media_id", "")
            for m in media:
                if isinstance(m, dict) and str(m.get("id", "")) == str(mid):
                    items.append({
                        "media_id": mid,
                        "url": m.get("url", ""),
                        "alt": m.get("alt") or m.get("title") or "",
                        "caption": m.get("caption") or "",
                        "fact_id": getattr(pin, "fact_id", ""),
                        "kind": (m.get("kind") or "image"),
                    })
                    break
        return {"label": "Inline media", "renderer_kind": "frontend", "items": items}

    if module_id == "media_gallery":
        items = []
        for m in media:
            if not isinstance(m, dict):
                continue
            mid = str(m.get("id", ""))
            if mid in pinned_ids:
                continue  # already pinned as inline
            kind = (m.get("kind") or "").lower()
            url = (m.get("url") or "").lower()
            is_image = (
                kind in {"image", "screenshot"}
                or url.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp"))
            )
            if is_image and not m.get("is_hero"):
                items.append({
                    "url": m.get("url", ""),
                    "alt": m.get("alt") or m.get("title") or "",
                    "caption": m.get("caption") or "",
                    "kind": "image",
                })
        return {"label": "Gallery", "renderer_kind": "frontend", "items": items}

    if module_id == "link_card":
        items = []
        for m in media:
            if not isinstance(m, dict):
                continue
            kind = (m.get("kind") or "").lower()
            url = (m.get("url") or "")
            if kind == "link" or (
                url.startswith("http")
                and not url.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp4", ".webm"))
                and "youtube.com" not in url.lower()
                and "vimeo.com" not in url.lower()
            ):
                items.append({
                    "url": url,
                    "title": m.get("title") or m.get("alt") or url,
                    "description": m.get("description") or m.get("caption") or "",
                    "favicon": m.get("favicon") or "",
                })
        return {"label": "Linked resource", "renderer_kind": "frontend", "items": items}

    if module_id == "pdf_preview":
        items = []
        for m in media:
            if not isinstance(m, dict):
                continue
            kind = (m.get("kind") or "").lower()
            url = (m.get("url") or "")
            if kind == "pdf" or url.lower().endswith(".pdf"):
                items.append({
                    "url": url,
                    "title": m.get("title") or m.get("alt") or "",
                    "thumbnail_url": m.get("thumbnail_url") or "",
                })
        return {"label": "Document", "renderer_kind": "frontend", "items": items}

    if module_id == "video_embed":
        items = []
        for m in media:
            if not isinstance(m, dict):
                continue
            url = (m.get("url") or "").lower()
            kind = (m.get("kind") or "").lower()
            video_kind: str | None = None
            if "youtube.com" in url or "youtu.be" in url:
                video_kind = "youtube"
            elif "vimeo.com" in url:
                video_kind = "vimeo"
            elif kind == "video" or url.endswith((".mp4", ".webm")):
                video_kind = "native"
            if video_kind:
                items.append({
                    "url": m.get("url", ""),
                    "kind": video_kind,
                    "title": m.get("title") or m.get("alt") or "",
                })
        return {"label": "Video", "renderer_kind": "frontend", "items": items}

    return {"label": module_id, "renderer_kind": "frontend"}


# Render-inputs contract.
#
# When the WikiCompiler wires `compile_topic_page_modular` into its
# topic-page path, the gather step MUST populate every key listed
# below that corresponds to a module the planner is allowed to pick.
# Missing keys silently produce empty modules — the planner picks the
# module because the signals said the data exists, the renderer gets
# an empty list, and the rendered markdown is `""`. The substitution
# pass then drops the marker, so the user sees an absent module that
# the planner selected. Hard to debug from page output alone.
#
# Keys, by module they feed:
#   - facts            → key_facts
#   - decisions        → decision_log
#   - events           → timeline
#   - alternatives     → comparison_matrix (also: criteria)
#   - criteria         → comparison_matrix (also: alternatives)
#   - pros, cons       → pros_cons
#   - quotes           → quote_highlights
#   - process_steps    → flow_chart (also: process_edges)
#   - process_edges    → flow_chart (also: process_steps)
#   - entities         → entity_diagram (also: relationships)
#   - relationships    → entity_diagram (also: entities)
#   - open_questions   → open_questions
#   - children         → subpage_cards
#   - related_topics   → related_threads
RENDER_INPUT_KEYS: dict[str, tuple[str, ...]] = {
    "key_facts": ("facts",),
    "decision_log": ("decisions",),
    "timeline": ("events",),
    "comparison_matrix": ("alternatives", "criteria"),
    "pros_cons": ("pros", "cons"),
    "quote_highlights": ("quotes",),
    "flow_chart": ("process_steps", "process_edges"),
    "entity_diagram": ("entities", "relationships"),
    "open_questions": ("open_questions",),
    "subpage_cards": ("children",),
    "related_threads": ("related_topics",),
}


def _per_module_data(module_id: str, render_inputs: dict[str, Any]) -> dict[str, Any]:
    """Pluck the per-module data the deterministic renderer expects
    from the orchestrator's ``render_inputs`` bag. The bag is built
    once by the orchestrator from the gathered cluster data — each
    module gets the slice it needs.

    Keeping this lookup table here (not in each module's render.py)
    means the modules stay decoupled from the compiler's internal
    data model — they only know their own input contract.

    The expected keys per module are documented in ``RENDER_INPUT_KEYS``
    above so the compiler's gather step has a single reference.
    """
    inputs_by_module: dict[str, dict[str, Any]] = {
        "key_facts": {"facts": render_inputs.get("facts", [])},
        "decision_log": {"decisions": render_inputs.get("decisions", [])},
        "timeline": {"events": render_inputs.get("events", [])},
        "comparison_matrix": {
            "alternatives": render_inputs.get("alternatives", []),
            "criteria": render_inputs.get("criteria", []),
        },
        "pros_cons": {
            "pros": render_inputs.get("pros", []),
            "cons": render_inputs.get("cons", []),
        },
        "quote_highlights": {"quotes": render_inputs.get("quotes", [])},
        "flow_chart": {
            "steps": render_inputs.get("process_steps", []),
            "edges": render_inputs.get("process_edges", []),
        },
        "entity_diagram": {
            "entities": render_inputs.get("entities", []),
            "relationships": render_inputs.get("relationships", []),
        },
        "open_questions": {"questions": render_inputs.get("open_questions", [])},
        "subpage_cards": {"children": render_inputs.get("children", [])},
        "related_threads": {"related": render_inputs.get("related_topics", [])},
    }
    return inputs_by_module.get(module_id, {})


def _render_python_module(module_id: str, data: dict[str, Any]) -> str:
    """Import + invoke the per-module Python renderer. Modules with
    ``renderer_kind == "frontend"`` (media modules) return an empty
    string here — the marker substitution drops them silently and
    the frontend renderer takes over via ``page.modules`` data.
    """
    spec = MODULE_CATALOG.get(module_id)
    if spec is None or spec.renderer_kind != "python":
        return ""
    try:
        mod = importlib.import_module(f"beever_atlas.wiki.modules.{module_id}")
    except ImportError as exc:
        logger.warning(
            "module_renderer_import_failed module=%s exc=%s", module_id, exc
        )
        return ""
    renderer = getattr(mod, "render", None)
    if not callable(renderer):
        logger.warning("module_renderer_missing module=%s", module_id)
        return ""
    try:
        out = renderer(data)
    except Exception as exc:  # noqa: BLE001 — never abort the page on one bad module
        logger.warning(
            "module_renderer_failed module=%s exc_type=%s exc=%s",
            module_id, type(exc).__name__, exc,
        )
        return ""
    return out if isinstance(out, str) else ""


def _assemble_content(tldr: str, overview: str, substituted_body: str) -> str:
    """Produce the final markdown the page is persisted with.

    Order: TL;DR (bold sentence) → blank line → Overview prose →
    blank line → body with substituted modules. Empty pieces are
    skipped so the result stays clean even when the LLM fell back.
    """
    parts: list[str] = []
    if tldr:
        parts.append(tldr if "**" in tldr else f"**{tldr.strip()}**")
    if overview:
        parts.append(overview.strip())
    if substituted_body:
        parts.append(substituted_body.strip())
    return "\n\n".join(p for p in parts if p)


def _parse_compile_json(raw: str) -> dict[str, Any]:
    """Parse the unified prompt's response. Strips a single outer
    markdown fence if the LLM wrapped despite being told not to.
    Validates the top-level shape but DOES NOT enforce the inner
    fields — they're sanity-checked by the caller during validation.
    """
    text = (raw or "").strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError(f"expected JSON object, got {type(parsed).__name__}")
    return parsed


def _fallback_output(title: str, render_inputs: dict[str, Any]) -> "ModularPageOutput":
    """Catastrophic fallback when the LLM call fails or produces
    unparseable output. Renders a single ``key_facts`` module if
    the data is there, otherwise a placeholder line. The page
    always renders something rather than 404-ing the user.

    ``key_facts`` is a frontend renderer in v2, so the fallback path
    builds the structured payload + a markdown table for the legacy
    page.content body via ``render_key_facts_table`` directly.
    """
    from beever_atlas.wiki.modules.key_facts import build_key_facts_data
    from beever_atlas.wiki.render import render_key_facts_table

    plan = ModulePlan(modules=[{"id": "key_facts", "anchor": "key-facts"}])
    facts = render_inputs.get("facts") or []
    rendered = render_key_facts_table(facts) if isinstance(facts, list) else ""
    if rendered:
        # Attach structured data payload so the frontend dispatcher
        # can render the v2 card list. The markdown body still
        # carries the legacy table so older readers + the page.content
        # cache see something readable.
        plan.modules[0]["data"] = build_key_facts_data(facts)
        content = f"**{title}**\n\n{rendered}"
    else:
        content = f"**{title}** — page content temporarily unavailable. Try a regenerate."
    return ModularPageOutput(
        content=content,
        summary="",
        modules=list(plan.modules),
        planner_module_count=len(plan.modules),
        rendered_module_count=1 if rendered else 0,
        fell_back=True,
    )


async def compile_topic_page_modular(
    *,
    title: str,
    summary: str,
    signals: dict[str, Any],
    render_inputs: dict[str, Any],
    top_facts: list[dict],
    top_people: list[dict],
    date_range_start: str = "",
    date_range_end: str = "",
    llm: LLMCallable,
) -> ModularPageOutput:
    """Single-call topic page compilation.

    Builds one prompt containing the catalog + signals + topic data,
    invokes the LLM once, parses the unified response, validates the
    plan, renders modules deterministically, substitutes markers,
    assembles the final content. Returns a renderable
    ``ModularPageOutput`` even on failure (fall-back is single
    ``key_facts`` module).

    Cost: one LLM call per topic page — same as the legacy
    ``TOPIC_PROMPT`` flow.
    """
    from beever_atlas.wiki.prompts import build_module_compile_prompt

    catalog_view = [
        {
            "id": spec.id,
            "label": spec.label,
            "description": spec.description,
            "rule": _HUMAN_RULES.get(spec.id, "Pick at planner's discretion."),
        }
        for spec in MODULE_CATALOG.values()
    ]
    prompt = build_module_compile_prompt(
        signals=signals,
        module_catalog=catalog_view,
        title=title,
        summary=summary,
        top_facts=top_facts,
        top_people=top_people,
        date_range_start=date_range_start,
        date_range_end=date_range_end,
    )

    # Stage 1 — single LLM call.
    try:
        result = llm(prompt)
        raw = await result if inspect.isawaitable(result) else result  # type: ignore[assignment]
    except Exception as exc:  # noqa: BLE001
        logger.exception("module_compile_llm_failed exc=%s", exc)
        return _fallback_output(title, render_inputs)

    # Stage 2 — parse JSON response.
    try:
        parsed = _parse_compile_json(str(raw))
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "module_compile_parse_failed exc=%s raw_len=%d", exc, len(str(raw))
        )
        return _fallback_output(title, render_inputs)

    # Stage 3 — validate the plan.
    plan_dict = parsed.get("plan") or {}
    if not isinstance(plan_dict, dict):
        plan_dict = {}
    plan = _validate_plan(plan_dict, signals)
    if plan.is_empty():
        logger.info("module_compile_plan_empty_fallback — using key_facts only")
        return _fallback_output(title, render_inputs)

    # Stage 4 — render each module deterministically + attach data
    # payload for the frontend dispatcher.
    rendered_modules: dict[str, str] = {}
    rendered_count = 0
    for entry in plan.modules:
        mid = entry["id"]
        # Defensive contract check — when the LLM picks a module but
        # the gather step didn't populate the keys the renderer
        # needs, the module renders empty and the marker silently
        # disappears. Surface this as a structured warning.
        expected_keys = RENDER_INPUT_KEYS.get(mid, ())
        missing = [k for k in expected_keys if not render_inputs.get(k)]
        if missing:
            logger.warning(
                "module_render_inputs_missing module=%s missing_keys=%s — "
                "module will render empty; gather step likely needs to "
                "populate these keys",
                mid, missing,
            )
        data = _per_module_data(mid, render_inputs)
        rendered = _render_python_module(mid, data)
        # ``key_facts`` is a frontend renderer in v2, but we still
        # render the legacy markdown table for the body marker so
        # page.content stays useful for the markdown-render path
        # (older readers, search index, copy-out). The structured
        # v2 payload is attached via ``_extract_media_for_module``
        # for the React dispatcher.
        if not rendered and mid == "key_facts":
            from beever_atlas.wiki.render import render_key_facts_table

            facts_for_legacy = render_inputs.get("facts") or []
            if isinstance(facts_for_legacy, list):
                rendered = render_key_facts_table(facts_for_legacy)
        if rendered:
            rendered_modules[mid] = rendered
            rendered_count += 1
        # Attach data payload for the frontend dispatcher. Two paths:
        # python-renderer modules persist their rendered markdown so
        # the dispatcher can render via WikiMarkdown; frontend-only
        # modules (media + key_facts v2) get the structured data
        # their React component needs.
        spec = MODULE_CATALOG.get(mid)
        if spec and spec.renderer_kind == "frontend":
            entry["data"] = _extract_media_for_module(
                mid, render_inputs, plan.media_pins
            )
        else:
            # Markdown is intentionally persisted in BOTH ``page.content``
            # (via marker substitution below) and ``module.data.markdown``
            # here. The duplication exists so the frontend dispatcher
            # path can render module-by-module without re-parsing
            # page.content.
            entry["data"] = {
                "label": spec.label if spec else mid,
                "renderer_kind": spec.renderer_kind if spec else "python",
                "markdown": rendered,
            }

    # Stage 5 — substitute markers in the body. Hard-fail wraps in a
    # ``ModuleSubstitutionError`` which we catch and degrade to the
    # markers-only fallback body so the page still renders.
    body = str(parsed.get("body") or "").strip()
    try:
        substituted_body = substitute_module_markers(body, rendered_modules)
        fell_back = False
    except ModuleSubstitutionError as exc:
        logger.warning("module_substitution_failed exc=%s", exc)
        substituted_body = ""
        fell_back = True

    # Stage 6 — assemble content from TL;DR + Overview + substituted body.
    tldr = str(parsed.get("tldr") or "").strip()
    overview = str(parsed.get("overview") or "").strip()
    content = _assemble_content(tldr, overview, substituted_body)
    if not content:
        # Catastrophic fallback — produce something so the page isn't
        # empty.
        content = f"**{title}** — page content temporarily unavailable. Try a regenerate."
        fell_back = True

    return ModularPageOutput(
        content=content,
        summary=summary,
        modules=list(plan.modules),
        media_pins=list(plan.media_pins),
        planner_module_count=len(plan.modules),
        rendered_module_count=rendered_count,
        fell_back=fell_back,
    )
