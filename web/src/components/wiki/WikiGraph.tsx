/**
 * Wiki graph view — renders the channel's wiki pages, their hierarchy
 * (parent/child edges), `[[wikilink]]` cross-references, and a central
 * Channel hub via Cytoscape.js.
 *
 * Cytoscape is loaded ONLY at mount time via dynamic ``import()`` so
 * the wiki tab's main bundle never pays its weight (§6.13). Until the
 * dynamic import resolves, a lightweight skeleton shows in place of
 * the canvas.
 *
 * Click a wiki node → opens an inline preview panel on the right with
 * the page's title, summary, section number, and an "Open in Wiki tab"
 * button that routes to the wiki tab WITH the right page selected via
 * a ``?page={pageId}`` query param. No 404s, no out-of-context
 * navigation.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { X, ExternalLink } from "lucide-react";
import { useWikiGraph, type WikiGraphPayload, type WikiGraphNode } from "@/hooks/useWikiGraph";

type LayoutKey = "concentric" | "cose" | "dagre" | "grid";
type KindFilter = "all" | "topic" | "entity" | "decisions" | "faq" | "action_items";
type WindowFilter = "all" | "1h" | "24h" | "7d";

interface FilterState {
  kind: KindFilter;
  touchedWithin: WindowFilter;
  minCitations: number;
}

const WINDOW_MS: Record<WindowFilter, number> = {
  all: Number.POSITIVE_INFINITY,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function applyFilters(
  payload: WikiGraphPayload,
  filters: FilterState,
): WikiGraphPayload {
  const now = Date.now();
  const cutoff =
    filters.touchedWithin === "all"
      ? null
      : now - WINDOW_MS[filters.touchedWithin];

  const nodes = payload.nodes.filter((n) => {
    // Channel hub always survives; the graph would float without it.
    if (n.data.kind === "channel") return true;
    if (filters.kind === "all") return true;
    if (filters.kind === "entity") return n.data.kind === "entity";
    if (n.data.kind !== "wiki") return false;
    return n.data.page_kind === filters.kind;
  });

  // Citation density filter — count incoming edges per node.
  const incoming = new Map<string, number>();
  for (const edge of payload.edges) {
    incoming.set(edge.data.target, (incoming.get(edge.data.target) ?? 0) + 1);
  }

  const visibleNodes = nodes.filter((n) => {
    if (filters.minCitations <= 0) return true;
    if (n.data.kind !== "wiki") return true;
    if (cutoff !== null) {
      const ts = n.data.last_updated ? Date.parse(n.data.last_updated) : 0;
      if (!Number.isFinite(ts) || ts < cutoff) return false;
    }
    return (incoming.get(n.data.id) ?? 0) >= filters.minCitations;
  });

  const visibleIds = new Set(visibleNodes.map((n) => n.data.id));
  const visibleEdges = payload.edges.filter(
    (e) => visibleIds.has(e.data.source) && visibleIds.has(e.data.target),
  );

  return {
    channel_id: payload.channel_id,
    nodes: visibleNodes,
    edges: visibleEdges,
  };
}

interface WikiGraphProps {
  channelId?: string;
}

interface WikiGraphSelectionData {
  id: string;
  pageId?: string;
  slug?: string;
  label: string;
  kind?: string;
  pageKind?: string;
  sectionNumber?: string;
  summary?: string;
  memoryCount?: number;
  lastUpdated?: string;
  isChannel: boolean;
  isEntity: boolean;
}

function selectionFromNode(node: WikiGraphNode): WikiGraphSelectionData {
  const d = node.data ?? {};
  const dAny = d as Record<string, unknown>;
  return {
    id: String(d.id ?? ""),
    pageId:
      typeof dAny.page_id === "string"
        ? dAny.page_id
        : typeof dAny.id === "string"
          ? dAny.id
          : undefined,
    slug: typeof dAny.slug === "string" ? dAny.slug : undefined,
    label: typeof d.label === "string" ? d.label : String(d.id ?? ""),
    kind: typeof d.kind === "string" ? d.kind : undefined,
    pageKind: typeof d.page_kind === "string" ? d.page_kind : undefined,
    sectionNumber:
      typeof dAny.section_number === "string"
        ? (dAny.section_number as string)
        : undefined,
    summary: typeof dAny.summary === "string" ? (dAny.summary as string) : undefined,
    memoryCount:
      typeof dAny.memory_count === "number"
        ? (dAny.memory_count as number)
        : undefined,
    lastUpdated:
      typeof d.last_updated === "string" ? d.last_updated : undefined,
    isChannel: d.kind === "channel",
    isEntity: d.kind === "entity",
  };
}

// Per-kind colors keep the graph legible when node count is large.
const KIND_COLORS: Record<string, string> = {
  channel: "#a855f7", // purple — central hub
  wiki_overview: "#0ea5e9", // sky — overview pages (page_kind="fixed" + slug=overview)
  wiki_fixed: "#22c55e", // green — fixed pages (people, faq, etc.)
  wiki_topic: "#3b82f6", // blue — topic pages
  wiki_subtopic: "#60a5fa", // light blue — sub-topics
  wiki_entity_page: "#f59e0b", // amber — entity wiki pages
  wiki_decisions: "#ef4444", // red — decisions
  wiki_faq: "#8b5cf6", // violet — FAQ
  wiki_action_items: "#14b8a6", // teal — action items
  wiki_default: "#3b82f6",
  entity: "#10b981", // emerald — graph entity nodes
};

function colorForNode(node: WikiGraphNode): string {
  const d = node.data ?? {};
  if (d.kind === "channel") return KIND_COLORS.channel;
  if (d.kind === "entity") return KIND_COLORS.entity;
  const slug = (d as Record<string, unknown>).slug as string | undefined;
  const pk = d.page_kind || "topic";
  if (slug === "overview") return KIND_COLORS.wiki_overview;
  if (pk === "fixed") return KIND_COLORS.wiki_fixed;
  if (pk === "sub-topic") return KIND_COLORS.wiki_subtopic;
  if (pk === "entity") return KIND_COLORS.wiki_entity_page;
  if (pk === "decisions") return KIND_COLORS.wiki_decisions;
  if (pk === "faq") return KIND_COLORS.wiki_faq;
  if (pk === "action_items") return KIND_COLORS.wiki_action_items;
  if (pk === "topic") return KIND_COLORS.wiki_topic;
  return KIND_COLORS.wiki_default;
}

// Pre-build elements with per-node color so the cytoscape style sheet
// can reference data(color) directly — keeps the style block small.
// Labels are truncated to ~28 chars to stop the outer ring from
// overlapping into an unreadable crush — the full title is on the
// preview panel + tooltip on hover, so the truncation is purely
// visual relief.
function _truncateLabel(raw: string, max = 28): string {
  const s = (raw || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function buildElements(filtered: WikiGraphPayload): unknown[] {
  const out: unknown[] = [];
  for (const node of filtered.nodes) {
    const isChannel = node.data.kind === "channel";
    const isEntity = node.data.kind === "entity";
    const rawLabel = node.data.label || node.data.id;
    out.push({
      data: {
        ...node.data,
        // Display label is truncated; the full ``label`` stays on the
        // panel + Obsidian-style hover tooltip (cytoscape's text-show
        // styling is driven by the visible-on-hover class added in
        // the mouseover handler).
        displayLabel: _truncateLabel(rawLabel),
        color: colorForNode(node),
        nodeSize: isChannel ? 64 : isEntity ? 30 : 36,
        labelSize: isChannel ? 16 : 12,
        labelWeight: isChannel ? 700 : 500,
      },
    });
  }
  for (const edge of filtered.edges) {
    out.push({ data: { ...edge.data } });
  }
  return out;
}

export function WikiGraph({ channelId: channelIdOverride }: WikiGraphProps = {}) {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const channelId = channelIdOverride ?? params.id;
  const { data, isLoading, error, refetch } = useWikiGraph(channelId);
  const [filters, setFilters] = useState<FilterState>({
    kind: "all",
    touchedWithin: "all",
    minCitations: 0,
  });
  // Default to force-directed cose — Obsidian-style natural spacing
  // distributes the outer-ring labels so they don't cram on top of
  // each other. Operators who want the explicit hierarchy can switch
  // to dagre or concentric from the dropdown.
  const [layout, setLayout] = useState<LayoutKey>("cose");
  const containerRef = useRef<HTMLDivElement | null>(null);
  // ``unknown`` because cytoscape's type surface (Core, ElementDefinition)
  // adds a non-trivial type-import; the runtime methods we touch
  // (``on`` + ``destroy``) are narrowed at use site.
  const cyRef = useRef<unknown>(null);
  const [cytoscapeReady, setCytoscapeReady] = useState(false);
  const [cytoscapeError, setCytoscapeError] = useState<string | null>(null);
  const [selection, setSelection] = useState<WikiGraphSelectionData | null>(null);

  const filtered = useMemo(
    () => (data ? applyFilters(data, filters) : null),
    [data, filters],
  );

  // Selection handler held in a ref so the cytoscape mount effect does
  // NOT depend on its identity — channelId / navigate identity changes
  // would otherwise destroy + remount the entire graph (visible flicker).
  const handleNodeTapRef = useRef<(nodeData: Record<string, unknown>) => void>(
    () => undefined,
  );
  handleNodeTapRef.current = useCallback((nodeData: Record<string, unknown>) => {
    // Empty data → background tap; clear selection.
    if (!nodeData || !nodeData.id) {
      setSelection(null);
      return;
    }
    const fakeNode: WikiGraphNode = { data: nodeData as WikiGraphNode["data"] };
    const sel = selectionFromNode(fakeNode);
    if (sel.isEntity) {
      // Entity nodes still navigate to the existing entity-graph route
      // since they reach beyond the wiki domain.
      if (channelId) {
        const entityName = sel.id.startsWith("entity:")
          ? sel.id.slice(7)
          : sel.label;
        navigate(`/channels/${channelId}/graph?entity=${encodeURIComponent(entityName)}`);
      }
      return;
    }
    // Wiki nodes + channel hub → open inline preview panel.
    setSelection(sel);
  }, [channelId, navigate]);

  const elements = useMemo(
    () => (filtered ? buildElements(filtered) : []),
    [filtered],
  );

  useEffect(() => {
    let alive = true;
    type CyTapEvent = {
      target: {
        id?: () => string;
        data?: () => Record<string, unknown>;
      };
    };
    type CyInstance = {
      // Cytoscape's ``on`` is overloaded: 2-arg form (event, handler) for
      // canvas-wide events, 3-arg form (event, selector, handler) for
      // element-bound events. Both are valid runtime calls.
      on: {
        (event: string, handler: (e: CyTapEvent) => void): void;
        (event: string, selector: string, handler: (e: CyTapEvent) => void): void;
      };
      destroy: () => void;
    };
    let cy: CyInstance | null = null;
    if (!filtered || !containerRef.current) return;

    (async () => {
      try {
        const module = await import("cytoscape");
        if (!alive) return;
        const cytoscape = (module as { default: unknown }).default ?? module;
        const factory = cytoscape as (config: Record<string, unknown>) => CyInstance;
        cy = factory({
          container: containerRef.current,
          elements,
          wheelSensitivity: 0.2,
          style: [
            {
              selector: "node",
              style: {
                label: "data(displayLabel)",
                "text-valign": "bottom",
                "text-halign": "center",
                "text-margin-y": 6,
                color: "#e5e7eb",
                "font-size": "data(labelSize)",
                "font-weight": "data(labelWeight)",
                "text-wrap": "wrap",
                "text-max-width": "140px",
                "text-outline-color": "#0f172a",
                "text-outline-width": 2,
                "background-color": "data(color)",
                width: "data(nodeSize)",
                height: "data(nodeSize)",
                "border-width": 1.5,
                "border-color": "rgba(255,255,255,0.15)",
                "transition-property":
                  "background-color, border-color, width, height, opacity",
                "transition-duration": 150,
              },
            },
            {
              selector: "node[kind = 'channel']",
              style: {
                "border-width": 3,
                "border-color": "rgba(168,85,247,0.6)",
                color: "#f3e8ff",
              },
            },
            {
              selector: "node.dimmed",
              style: { opacity: 0.25 },
            },
            {
              selector: "node.highlighted",
              style: {
                "border-width": 3,
                "border-color": "#fbbf24",
                "z-index": 999,
              },
            },
            {
              selector: "node.neighbor",
              style: {
                "border-width": 2,
                "border-color": "#facc15",
              },
            },
            {
              selector: "node:selected",
              style: {
                "border-color": "#fbbf24",
                "border-width": 3,
              },
            },
            {
              selector: "edge",
              style: {
                width: 1.5,
                "line-color": "rgba(148,163,184,0.5)",
                "target-arrow-color": "rgba(148,163,184,0.6)",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
                "arrow-scale": 0.8,
                "transition-property": "line-color, opacity, width",
                "transition-duration": 150,
              },
            },
            { selector: "edge.dimmed", style: { opacity: 0.1 } },
            {
              selector: "edge.highlighted",
              style: {
                width: 2.5,
                "line-color": "#facc15",
                "target-arrow-color": "#facc15",
                "z-index": 999,
              },
            },
            {
              selector: "edge[kind = 'belongs_to']",
              style: {
                "line-color": "rgba(168,85,247,0.4)",
                "target-arrow-color": "rgba(168,85,247,0.5)",
                "line-style": "dotted",
                width: 1,
              },
            },
            {
              selector: "edge[kind = 'child_of']",
              style: {
                "line-color": "rgba(96,165,250,0.6)",
                "target-arrow-color": "rgba(96,165,250,0.7)",
                width: 1.5,
              },
            },
            {
              selector: "edge[kind = 'references_wiki']",
              style: {
                "line-color": "#3b82f6",
                "target-arrow-color": "#3b82f6",
                width: 2,
              },
            },
            {
              selector: "edge[kind = 'references_entity']",
              style: {
                "line-style": "dashed",
                "line-color": "rgba(16,185,129,0.6)",
                "target-arrow-color": "rgba(16,185,129,0.7)",
              },
            },
          ],
          layout:
            layout === "concentric"
              ? {
                  name: "concentric",
                  fit: true,
                  padding: 60,
                  minNodeSpacing: 80,
                  spacingFactor: 1.4,
                  // Channel hub at center, then top-level pages, then deeper.
                  concentric: (node: { data: (k: string) => unknown }) => {
                    const kind = node.data("kind");
                    if (kind === "channel") return 1000;
                    const pageKind = node.data("page_kind") || "";
                    if (pageKind === "fixed") return 100;
                    if (pageKind === "sub-topic") return 10;
                    return 50;
                  },
                  levelWidth: () => 1,
                  animate: false,
                }
              : layout === "dagre"
                ? {
                    name: "dagre",
                    rankDir: "TB",
                    animate: false,
                    nodeSep: 70,
                    edgeSep: 30,
                    rankSep: 100,
                  }
                : layout === "grid"
                  ? { name: "grid", animate: false, padding: 40 }
                  : {
                      name: "cose",
                      animate: false,
                      // Generous spring length + vertex repulsion so the
                      // 60+ wiki nodes spread out instead of crushing
                      // labels into each other.
                      idealEdgeLength: 140,
                      nodeOverlap: 24,
                      nodeRepulsion: 8_000_000,
                      edgeElasticity: 60,
                      gravity: 0.15,
                      padding: 60,
                      fit: true,
                    },
        });
        // Click — Obsidian-style: highlight the clicked node + its
        // direct neighbors, dim the rest, fire selection callback.
        const cyAny = cy as unknown as {
          elements: () => {
            removeClass: (c: string) => void;
            addClass: (c: string) => void;
          };
          getElementById: (id: string) => {
            length: number;
            data: () => Record<string, unknown>;
            closedNeighborhood: () => {
              removeClass: (c: string) => void;
              addClass: (c: string) => void;
              edges: () => { addClass: (c: string) => void };
            };
          };
        };
        const clearHighlights = () => {
          cyAny.elements().removeClass("dimmed highlighted neighbor");
        };
        cy.on("tap", "node", (e) => {
          const evtTarget = (e as unknown as {
            target: {
              id: () => string;
              data: () => Record<string, unknown>;
              closedNeighborhood: () => {
                removeClass: (c: string) => void;
                addClass: (c: string) => void;
                edges: () => { addClass: (c: string) => void };
              };
            };
          }).target;
          const nodeId = evtTarget.id();
          const nodeData = evtTarget.data();
          // Visual highlight pass — same pattern as the entity GraphCanvas.
          cyAny.elements().removeClass("dimmed highlighted neighbor");
          cyAny.elements().addClass("dimmed");
          const neighborhood = evtTarget.closedNeighborhood();
          neighborhood.removeClass("dimmed");
          neighborhood.addClass("neighbor");
          neighborhood.edges().addClass("highlighted");
          // Mark the clicked node itself with the brighter "highlighted" class.
          const ele = cyAny.getElementById(nodeId);
          if (ele.length > 0) {
            ele.closedNeighborhood().removeClass("dimmed");
          }
          handleNodeTapRef.current(nodeData);
        });
        // Background tap clears the selection + highlights.
        cy.on("tap", (e) => {
          const evtTarget = (e as unknown as { target: unknown }).target;
          if (evtTarget === cy) {
            clearHighlights();
            handleNodeTapRef.current({});
          }
        });
        cyRef.current = cy;
        setCytoscapeReady(true);
      } catch (err) {
        if (!alive) return;
        const message = err instanceof Error ? err.message : "cytoscape failed to load";
        setCytoscapeError(message);
      }
    })();

    return () => {
      alive = false;
      try {
        if (cy) cy.destroy();
      } catch {
        /* destroy is best-effort */
      }
      cyRef.current = null;
    };
    // ``handleNodeTapRef`` intentionally absent — the ref's `.current`
    // is updated above so cytoscape always sees the latest closure
    // without needing to remount.
  }, [elements, layout]);

  return (
    <div className="flex h-full flex-col" data-testid="wiki-graph-root">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card/60 px-5 py-3">
        <h2 className="text-base font-semibold text-foreground whitespace-nowrap">
          Wiki graph
        </h2>
        <select
          aria-label="Filter by page kind"
          value={filters.kind}
          onChange={(e) =>
            setFilters((s) => ({ ...s, kind: e.target.value as KindFilter }))
          }
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          data-testid="wiki-graph-filter-kind"
        >
          <option value="all">All kinds</option>
          <option value="topic">Topic</option>
          <option value="entity">Entity</option>
          <option value="decisions">Decisions</option>
          <option value="faq">FAQ</option>
          <option value="action_items">Action items</option>
        </select>
        <select
          aria-label="Filter by last touched"
          value={filters.touchedWithin}
          onChange={(e) =>
            setFilters((s) => ({
              ...s,
              touchedWithin: e.target.value as WindowFilter,
            }))
          }
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="all">Any time</option>
          <option value="1h">Last hour</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7d</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
          Citation density ≥
          <input
            aria-label="Minimum citation density"
            type="number"
            min={0}
            max={20}
            value={filters.minCitations}
            onChange={(e) =>
              setFilters((s) => ({
                ...s,
                minCitations: Number.isNaN(parseInt(e.target.value, 10))
                  ? 0
                  : parseInt(e.target.value, 10),
              }))
            }
            className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
        </label>
        <select
          aria-label="Graph layout"
          value={layout}
          onChange={(e) => setLayout(e.target.value as LayoutKey)}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="concentric">Concentric (hub-first)</option>
          <option value="dagre">Dagre (top-down)</option>
          <option value="cose">Cose (force-directed)</option>
          <option value="grid">Grid</option>
        </select>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted whitespace-nowrap"
        >
          Refresh
        </button>
        <Legend />
      </header>

      <div className="relative flex flex-1 min-h-0">
        <div className="relative flex-1 bg-muted/10">
          {error && (
            <div
              className="absolute inset-0 flex items-center justify-center text-sm text-red-500"
              role="alert"
            >
              {error}
            </div>
          )}
          {cytoscapeError && (
            <div
              className="absolute inset-0 flex items-center justify-center text-sm text-amber-500"
              role="alert"
            >
              Graph engine failed to load: {cytoscapeError}
            </div>
          )}
          {(isLoading || (!cytoscapeReady && !cytoscapeError)) && (
            <div
              className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
              data-testid="wiki-graph-loading"
            >
              Loading wiki graph…
            </div>
          )}
          <div
            ref={containerRef}
            className="h-full w-full"
            data-testid="wiki-graph-canvas"
            data-node-count={filtered?.nodes.length ?? 0}
            data-edge-count={filtered?.edges.length ?? 0}
          />
        </div>

        {selection && (
          <WikiGraphPanel
            channelId={channelId}
            selection={selection}
            onClose={() => setSelection(null)}
          />
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-border bg-card/60 px-5 py-2 text-xs text-muted-foreground">
        <span>
          {filtered?.nodes.length ?? 0} nodes · {filtered?.edges.length ?? 0} edges
          {selection && (
            <>
              {" · "}
              <span className="text-foreground">{selection.label}</span> selected
            </>
          )}
        </span>
        <span className="opacity-70">channel {channelId}</span>
      </footer>
    </div>
  );
}

function Legend() {
  const items: Array<{ color: string; label: string }> = [
    { color: KIND_COLORS.channel, label: "Channel hub" },
    { color: KIND_COLORS.wiki_overview, label: "Overview" },
    { color: KIND_COLORS.wiki_topic, label: "Topic" },
    { color: KIND_COLORS.wiki_subtopic, label: "Sub-topic" },
    { color: KIND_COLORS.wiki_decisions, label: "Decisions" },
    { color: KIND_COLORS.wiki_faq, label: "FAQ" },
    { color: KIND_COLORS.entity, label: "Entity" },
  ];
  return (
    <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

interface WikiGraphPanelProps {
  channelId?: string;
  selection: WikiGraphSelectionData;
  onClose: () => void;
}

function WikiGraphPanel({ channelId, selection, onClose }: WikiGraphPanelProps) {
  const navigate = useNavigate();
  const goToWikiPage = () => {
    if (!channelId || !selection.pageId) return;
    // Navigate to the channel wiki tab with the selected page in the
    // query param. WikiTab consumes ``?page={pageId}`` and points
    // ``activePageId`` at it on mount.
    navigate(
      `/channels/${channelId}/wiki?page=${encodeURIComponent(selection.pageId)}`,
    );
  };

  return (
    <aside
      className="w-80 shrink-0 border-l border-border bg-card/95 overflow-y-auto shadow-2xl backdrop-blur-sm"
      role="complementary"
      aria-label="Wiki graph node details"
      data-testid="wiki-graph-panel"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {selection.isChannel
            ? "Channel hub"
            : selection.isEntity
              ? "Entity"
              : "Wiki page"}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Close preview"
        >
          <X size={14} />
        </button>
      </div>
      <div className="space-y-3 px-4 py-4">
        <div>
          <h3 className="text-base font-semibold text-foreground leading-tight">
            {selection.label}
          </h3>
          {selection.sectionNumber && (
            <p className="mt-1 text-xs text-muted-foreground">
              Section {selection.sectionNumber}
            </p>
          )}
          {selection.pageKind && !selection.isChannel && !selection.isEntity && (
            <p className="mt-1 text-xs text-muted-foreground capitalize">
              Kind: {selection.pageKind}
            </p>
          )}
        </div>
        {selection.summary && (
          <p className="text-sm text-foreground/80 leading-relaxed">
            {selection.summary}
          </p>
        )}
        {!selection.summary && !selection.isChannel && !selection.isEntity && (
          <p className="text-xs text-muted-foreground italic">
            No summary cached yet. Open the page to read its content.
          </p>
        )}
        {typeof selection.memoryCount === "number" && selection.memoryCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {selection.memoryCount} memories
          </p>
        )}
        {selection.lastUpdated && (
          <p className="text-xs text-muted-foreground">
            Updated {new Date(selection.lastUpdated).toLocaleString()}
          </p>
        )}
        {!selection.isChannel && !selection.isEntity && selection.pageId && (
          <button
            type="button"
            onClick={goToWikiPage}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <ExternalLink size={12} />
            Open in Wiki tab
          </button>
        )}
      </div>
    </aside>
  );
}

export default WikiGraph;
