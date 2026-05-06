# Wiki Narrative Articles — operator rollout runbook

This runbook covers Phase 10 of the
[`wiki-narrative-articles`](../../openspec/changes/wiki-narrative-articles/proposal.md)
OpenSpec change — flipping the `WIKI_NARRATIVE_ARTICLES` feature flag
on a real channel, validating output quality, and rolling back via
flag flip if the synthesized articles regress on a particular
channel shape.

## What the feature does

The narrative-articles change adds a multi-section explanatory
article to the top of every wiki page, replacing the previous
"stack of data modules" layout. Section titles emerge from cluster
content (e.g., "Integrate OpenClaw with Beever Atlas") instead of
being picked from a fixed template; every paragraph cites at least
one `fact_id`; existing 26 modules render below the article in a
collapsible "Reference & Evidence" appendix. The orchestrator emits
ONE LLM call per page (same cardinality as the v2 prompt) — output
tokens grow ~30-60%, total cost stays well below the 2-3x increase
a multi-pass approach would incur.

## Default rollout state

- `WIKI_NARRATIVE_ARTICLES` env var is **OFF by default** at every
  deployment tier (local dev, staging, production).
- Pre-flag wiki pages render with today's module-only behavior.
- The new `narrative_article` module renders nothing when no
  validated `narrative_sections` are persisted on the page.

## Enabling per-channel (preferred)

Per-channel toggle is the **recommended** activation path — it
limits blast radius, lets the operator A/B-compare a single channel
against the rest, and short-circuits a global flag flip if quality
regresses on one channel shape.

1. Open the channel's config in the channel-config admin store.
2. Set `wiki.narrative_articles_enabled: true` on that channel.
3. Trigger a full wiki regen for that channel:

   ```bash
   curl -X POST "https://atlas/api/channels/<channel_id>/wiki/refresh?mode=full" \
     -H "Authorization: Bearer $BEARER"
   ```

4. Wait for `extraction_status="done"` on every fact in the channel
   (or use the operator dashboard to check progress).
5. Visit a topic page in the live web UI and validate (see
   [Validation checklist](#validation-checklist) below).

Per-channel `True` always wins over the global env var being
`False`. The reverse is also true: a per-channel `False` (explicit)
overrides a global `True`. This is the existing
maintenance-mode pattern; see `_narrative_articles_enabled()` in
`src/beever_atlas/wiki/modules/orchestrator.py`.

## Enabling globally (deferred — only after 4+ weeks of soak)

After at least 4 weeks of soak across 2-3 channels with healthy
telemetry, you may flip the global flag.

```bash
# Edit the deployment env (e.g. fly.toml, k8s ConfigMap, .env):
WIKI_NARRATIVE_ARTICLES=true
```

After redeployment, every NEW page regen on every channel uses the
v3 prompt + narrative generation. Existing channels with explicit
per-channel `False` continue to opt out.

## Rollback

The feature is fully rollback-able via flag flip — no code change
required.

- **Per-channel rollback**: set `wiki.narrative_articles_enabled: false`
  on the channel; trigger regen. The next compile uses the v2 prompt
  and persists `narrative_sections=[]`. The frontend falls back to
  module-only layout (existing modules render at top, no
  "Reference & Evidence" appendix label).
- **Global rollback**: set `WIKI_NARRATIVE_ARTICLES=false` and
  redeploy. Existing pages keep their cached `narrative_sections`
  on disk (they don't disappear) but no new pages get narrative
  generation. To purge cached articles, force a regen with the
  flag off — the orchestrator persists `narrative_sections=[]` and
  the article disappears.
- **Implicit rollback** (no operator action): if the LLM fails JSON
  parse or the validator rejects the narrative on citation
  coverage, the orchestrator logs
  `narrative_article_fallback reason=<reason> page=<slug>` and
  persists `narrative_sections=[]` for that page. The user sees a
  working module-only page; the operator sees a telemetry warning.

## Telemetry queries to watch

The orchestrator emits structured log lines per page; surface them
via your log aggregator (Loki, Splunk, etc.):

| Metric | Log line | Health threshold |
|---|---|---|
| Article generation success | `narrative_article_persisted page=<slug> sections=<n>` | ≥ 90% of pages |
| Citation coverage (median) | `narrative_telemetry coverage=<pct>` | ≥ 80% median |
| Output token growth | `narrative_output_tokens=<n>` (vs. v2 baseline) | ≤ 1.6x baseline median |
| Fallback rate | `narrative_article_fallback reason=<reason>` | < 10% of regens |
| Forbidden-phrase drops | `narrative_paragraph_dropped reason=activity_narration` | < 5% of paragraphs |
| Section-cap violations | `narrative_section_over_cap section=<a> words=<n>` | < 1% of sections |

Operator dashboard: `GET /api/admin/wiki/narrative-health?channel_id=<id>`
returns per-channel narrative health (% of pages with full articles,
median citation coverage, median word count, fallback rate, dominant
fallback reasons).

## Validation checklist

After enabling on a channel, manually validate **at least one page
of each shape** before committing to soak:

### Topic page (default archetype)
- [ ] Article appears at the top with 3-7 sections.
- [ ] Section titles emerge from facts, not templates (e.g., a
  section titled "Integrate OpenClaw with Beever Atlas" — content-
  driven — not "Context" / "Background").
- [ ] Every paragraph has at least one `[f_xxx]` citation chip.
- [ ] Citation chips show fact preview on hover.
- [ ] Reading-time estimate appears at the article header.
- [ ] "X memories synthesized" badge appears with a reasonable
  count (typically 5-15 distinct fact_ids).
- [ ] Existing modules (`key_facts`, `decision_log`, etc.) render
  below the article in a collapsible "Reference & Evidence"
  appendix.
- [ ] No "shared a link" / "noted that" narration anywhere.

### Decision page
- [ ] Article reflects the Decision archetype hint structure
  (Context / Decision / Why / Alternatives / Implications) **when
  the data supports it** — but content-driven section titles are
  preferred over generic "Context"/"Why" labels.
- [ ] `decision_banner` module appears in the appendix.

### Folder page
- [ ] Article synthesizes ACROSS descendants — sections discuss
  cross-cutting threads, not duplicate child summaries.
- [ ] `subpage_cards` module appears in the appendix.

### Channel overview
- [ ] Article extends to up to 5,000 words (the landmark cap).
- [ ] Sections cover what-is / architecture / current priorities /
  recent decisions / open questions / roadmap (when data supports).

### Tension page (when surfaced by tension detector)
- [ ] Position A and Position B render with EQUAL weight.
- [ ] No editorial side-taking in the prose.
- [ ] `tension_callout` module appears in the appendix.

## Soak plan (recommended)

1. **Week 1** — internal `tech-beever-atlas` channel only. Validate
   above checklist; check telemetry; collect dogfood feedback.
2. **Week 2-3** — 1-2 customer channels with operator buy-in. Soak
   with daily telemetry checks; address any per-channel quality
   regressions before broadening.
3. **Week 4+** — broaden to 5-10 channels. Once telemetry stays
   healthy across all, consider global default-ON for new channels.

## Known issues / soak observations to watch for

These were identified during design + Phase 1-9 testing. None block
rollout, but watch for them in soak telemetry:

- **Hallucinated content not supported by source facts.** Mitigation:
  validator drops uncited paragraphs; `is_inference: true` paragraphs
  must still cite ≥ 1 fact_id. If hallucinations leak through, the
  operator can flag a paragraph via the existing curation API; track
  per-channel hallucination rate. If a single channel exceeds 5%
  hallucination rate, disable narrative on that channel and file a
  prompt-tuning ticket.
- **Bland or repetitive sections across pages.** Mitigation: archetype
  hints differ per page kind; the prompt forbids "shared a link" /
  "noted that" narration. Watch for sections that read as filler
  ("This topic discusses several important things"); these usually
  indicate thin source data — consider dropping the page below
  archetype-detection thresholds.
- **Output tokens balloon beyond +60% target.** Mitigation: word caps
  per section (150-400) and per article (1,500-3,000 typical, 5,000+
  landmark). Soak telemetry tracks `narrative_output_tokens`; alert
  if median page exceeds 1.6x v2 baseline.
- **Sections over the 400-word cap.** Mitigation: validator truncates
  at the last sentence boundary before the cap; logs
  `narrative_section_over_cap section=<a> words=<n>`. Persistent
  over-cap on a specific page shape signals a prompt-tuning issue.
- **TOC competes with sidebar/header layout on mid-width viewports.**
  Mitigation: TOC is sticky right-rail when viewport ≥ 1024px;
  collapses into a "Jump to section" dropdown below threshold. If
  the TOC obscures content on a specific viewport size, file a
  frontend ticket.
- **MCP `read_wiki_section` returns mostly-empty data when the page
  predates narrative generation.** Mitigation: tool returns
  `{error: "narrative_not_available", page_slug, has_modules: true}`
  so agents fall back to `read_wiki_page`. If an LLM agent
  consistently hits this path on a channel that should have
  narrative, that channel needs a regen.

## Pointers

- Feature flag implementation:
  `src/beever_atlas/infra/config.py::settings.wiki_narrative_articles_enabled`
- Per-channel override + flag dispatch:
  `src/beever_atlas/wiki/modules/orchestrator.py::_narrative_articles_enabled`
- v3 prompt + archetype hint blocks:
  `src/beever_atlas/wiki/prompts.py::build_module_compile_prompt_v3` +
  `get_archetype_hint_block`
- Validator (citation discipline + word caps):
  `src/beever_atlas/wiki/modules/narrative_validator.py`
- Frontend article + TOC:
  `web/src/components/wiki/modules/NarrativeArticleModule.tsx` +
  `web/src/components/wiki/NarrativeTOC.tsx`
- MCP retrieval tool:
  `src/beever_atlas/api/mcp_server/_tools_retrieval.py::read_wiki_section`
- Telemetry endpoint:
  `GET /api/admin/wiki/narrative-health?channel_id=<id>`
