/**
 * Platform-aware reply renderer.
 *
 * Replaces the old flat `formatBlockKit` string for ALL platforms. Given an
 * assembled `AskResult` and the originating platform, it produces a single
 * markdown body that:
 *   - leads with the answer,
 *   - lists up to {@link MAX_CITATIONS} sources with a kind icon + provenance,
 *   - shows channel freshness when known,
 *   - appends a subtle route footer,
 *   - is hard-capped to the platform's message length so the adapter never
 *     rejects an over-long post.
 *
 * When `result.isEmpty` is set it renders an honest, actionable empty state
 * instead of surfacing an LLM "I couldn't find anything" essay.
 *
 * The output is plain markdown, which every adapter (Slack mrkdwn, Discord,
 * Teams, Telegram, Mattermost) renders acceptably. Native rich cards / buttons
 * are a deliberate follow-up (they need the SDK `onAction` webhook wired up).
 */

import type { AskResult, Citation } from "./types.js";

/**
 * Per-platform max message length (chars), set conservatively below each
 * platform's true ceiling so we truncate before the adapter would reject.
 * `unknown` is the safe default for unrecognized thread-id prefixes.
 */
export const CHAR_CAP: Record<string, number> = {
  slack: 3900,
  discord: 1950,
  teams: 27000,
  telegram: 4000,
  mattermost: 16000,
  unknown: 3500,
};

const MAX_CITATIONS = 5;
const TRUNCATE_SUFFIX = "\n…_[truncated]_";

/** Icon per citation kind so wiki / message / decision / graph sources read at a glance. */
const KIND_ICON: Record<string, string> = {
  wiki_page: "📖",
  channel_message: "💬",
  qa_history: "💬",
  decision_record: "⚖️",
  graph_relationship: "🧠",
  media: "🖼️",
  uploaded_file: "📎",
  web_result: "🌐",
};

function iconFor(kind: string): string {
  return KIND_ICON[kind] ?? "•";
}

function capFor(platform: string): number {
  return CHAR_CAP[platform] ?? CHAR_CAP.unknown;
}

/** Truncate to a hard char budget, appending a marker when content was cut. */
export function enforceCap(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const budget = Math.max(0, cap - TRUNCATE_SUFFIX.length);
  return text.slice(0, budget).trimEnd() + TRUNCATE_SUFFIX;
}

function renderCitationLine(c: Citation, i: number): string {
  let line = `${iconFor(c.type)} [${i + 1}] ${c.text}`.trim();
  const meta: string[] = [];
  if (c.author) meta.push(c.author);
  if (c.source) meta.push(c.source);
  if (meta.length) line += ` — ${meta.join(", ")}`;
  if (c.url) line += ` <${c.url}>`;
  return line;
}

export function renderCitations(citations: Citation[]): string {
  if (citations.length === 0) return "";
  const shown = citations.slice(0, MAX_CITATIONS);
  const lines = shown.map(renderCitationLine).join("\n");
  const overflow = citations.length - shown.length;
  const more = overflow > 0 ? `\n_+${overflow} more_` : "";
  return `\n\n📎 *Sources*\n${lines}${more}`;
}

/** Human-friendly "Xm/Xh/Xd ago" from an ISO timestamp; null if unparseable. */
export function relativeTime(iso: string, now: number = Date.now()): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = now - t;
  if (diffMs < 60_000) return "just now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function renderFreshness(lastSyncTs?: string): string {
  if (!lastSyncTs) return "";
  const rel = relativeTime(lastSyncTs);
  return rel ? `\n🕐 _synced ${rel}_` : "";
}

function renderRoute(route: string): string {
  return `\n_via ${route}_`;
}

/**
 * Honest, actionable empty state — replaces the old wall of
 * "I could not find any indexed memories…" text. Short, and points to the
 * next step instead of dead-ending.
 */
export function renderEmptyState(result: AskResult, platform: string): string {
  const lines = [
    "I don't have anything indexed for that in this channel yet.",
    "",
    "• The channel may not be synced yet — an admin can trigger a sync.",
    "• Try rephrasing, or ask in a channel that's already indexed.",
  ];
  const freshness = renderFreshness(result.lastSyncTs);
  if (freshness) lines.push(freshness.trimStart());
  return enforceCap(lines.join("\n"), capFor(platform));
}

/** Render a full reply for the given platform. */
export function renderResponse(result: AskResult, platform: string): string {
  const plat = (platform || "unknown").toLowerCase();
  if (result.isEmpty) return renderEmptyState(result, plat);

  const body =
    (result.answer || "").trimEnd() +
    renderCitations(result.citations || []) +
    renderFreshness(result.lastSyncTs) +
    renderRoute(result.route || "qa_agent");

  return enforceCap(body, capFor(plat));
}
