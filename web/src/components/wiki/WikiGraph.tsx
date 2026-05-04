/**
 * Wiki graph view — renders the channel's wiki pages, their hierarchy
 * (parent/child edges), `[[wikilink]]` cross-references, and a central
 * Channel hub via Cytoscape.js + cytoscape-fcose.
 *
 * Layout: fcose with kind-based clustering. Pages of the same page_kind
 * get pulled together by virtual cluster membership, producing visible
 * "islands" per kind (Topic island, FAQ island, Decisions island, etc.)
 * around the central channel hub. This solves the "everything looks the
 * same on one ring" problem while keeping the organic graph feel.
 *
 * Cards: 72×52 rounded rectangles with a left-edge colored ribbon
 * (3 px, kind color) and a 12 px legible title below — readable at
 * default zoom without hovering.
 *
 * Filters: floating left panel matching MemoryGraphView.tsx — slim
 * collapsed pill expands to a vertical panel with kind toggles, time
 * window, density slider, and a search box. The old top filter strip
 * is gone.
 *
 * Cytoscape is loaded ONLY at mount via dynamic import() (§6.13 —
 * bundle-weight contract). fcose is also lazy-loaded the same way.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { X, ExternalLink, Loader2, SlidersHorizontal, ChevronLeft, Search } from "lucide-react";
import { useWikiGraph, type WikiGraphPayload, type WikiGraphNode } from "@/hooks/useWikiGraph";
import { useWikiPage } from "@/hooks/useWikiPage";
import { WikiMarkdown } from "@/components/wiki/WikiMarkdown";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type LayoutKey = "fcose" | "cose" | "dagre" | "grid";
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

// ─── Kind metadata ────────────────────────────────────────────────────────────
// Each kind gets a distinct hue with enough separation that the eye can
// immediately tell kinds apart — the previous palette was mostly blue (#).

const KIND_META: Record<
  string,
  { color: string; ribbon: string; label: string }
> = {
  channel:          { color: "#a855f7", ribbon: "#a855f7", label: "Hub" },
  wiki_overview:    { color: "#0ea5e9", ribbon: "#0ea5e9", label: "Overview" },
  wiki_fixed:       { color: "#22c55e", ribbon: "#22c55e", label: "Fixed" },
  wiki_topic:       { color: "#3b82f6", ribbon: "#3b82f6", label: "Topic" },
  wiki_subtopic:    { color: "#38bdf8", ribbon: "#38bdf8", label: "Sub-topic" },
  wiki_entity_page: { color: "#f59e0b", ribbon: "#f59e0b", label: "Entity page" },
  wiki_decisions:   { color: "#f43f5e", ribbon: "#f43f5e", label: "Decisions" },
  wiki_faq:         { color: "#8b5cf6", ribbon: "#8b5cf6", label: "FAQ" },
  wiki_action_items:{ color: "#14b8a6", ribbon: "#14b8a6", label: "Actions" },
  wiki_default:     { color: "#3b82f6", ribbon: "#3b82f6", label: "Page" },
  entity:           { color: "#10b981", ribbon: "#10b981", label: "Entity" },
};

function kindKeyForNode(node: WikiGraphNode): string {
  const d = node.data ?? {};
  if (d.kind === "channel") return "channel";
  if (d.kind === "entity") return "entity";
  const slug = (d as Record<string, unknown>).slug as string | undefined;
  const pk = d.page_kind || "topic";
  if (slug === "overview") return "wiki_overview";
  if (pk === "fixed") return "wiki_fixed";
  if (pk === "sub-topic") return "wiki_subtopic";
  if (pk === "entity") return "wiki_entity_page";
  if (pk === "decisions") return "wiki_decisions";
  if (pk === "faq") return "wiki_faq";
  if (pk === "action_items") return "wiki_action_items";
  if (pk === "topic") return "wiki_topic";
  return "wiki_default";
}

function colorForNode(node: WikiGraphNode): string {
  return KIND_META[kindKeyForNode(node)]?.color ?? KIND_META.wiki_default.color;
}

// ─── Filter logic ─────────────────────────────────────────────────────────────

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
    if (n.data.kind === "channel") return true;
    if (filters.kind === "all") return true;
    if (filters.kind === "entity") return n.data.kind === "entity";
    if (n.data.kind !== "wiki") return false;
    return n.data.page_kind === filters.kind;
  });

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

// ─── Label helpers ────────────────────────────────────────────────────────────

function _truncateLabel(raw: string, max = 22): string {
  const s = (raw || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function buildLabel(node: WikiGraphNode): string {
  const d = node.data ?? {};
  const raw = (typeof d.label === "string" ? d.label : String(d.id ?? "")).trim();
  return _truncateLabel(raw);
}

// ─── Icon SVGs (base64 data URLs) ─────────────────────────────────────────────
// Replaced with sharper, more minimal glyphs that read well at small sizes.
// Page icon: a simple corner-fold document shape, stroked white.
// Hub icon:  a Notion-style "stack of pages" that reads as "workspace root".

// Page icon: a soft filled-paper glyph with folded corner + three
// content bars. Filled shapes (rather than the previous all-stroked
// outline) read MUCH better at the 78×52 card size — the eye locks
// onto the silhouette instantly. White at 95% on the colored card
// background; corner-fold cut with a subtle shadow gradient.
const PAGE_ICON_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    // Outer page body — main filled shape with rounded edges + cut corner.
    // The path is a rounded rect with the top-right corner replaced by a
    // diagonal that goes (15,3) → (21,9), creating the dog-ear shape.
    '<path d="M5 4 a1.5 1.5 0 0 1 1.5 -1.5 h9 L21 8.5 V20 a1.5 1.5 0 0 1 -1.5 1.5 H6.5 a1.5 1.5 0 0 1 -1.5 -1.5 z" ' +
    'fill="rgba(255,255,255,0.95)"/>' +
    // Folded-corner triangle on the dog-ear, slightly darker so it reads
    // as a folded flap, not just a flat cut.
    '<path d="M15 3 V8.5 H21 z" fill="rgba(255,255,255,0.55)"/>' +
    // Three content lines as filled rounded rects (cleaner than strokes
    // at small sizes). Vary widths so they hint at "real text content".
    '<rect x="8" y="11" width="8" height="1.3" rx="0.65" fill="rgba(0,0,0,0.42)"/>' +
    '<rect x="8" y="14" width="9" height="1.3" rx="0.65" fill="rgba(0,0,0,0.42)"/>' +
    '<rect x="8" y="17" width="6" height="1.3" rx="0.65" fill="rgba(0,0,0,0.42)"/>' +
    '</svg>',
);
const PAGE_ICON_URL = `data:image/svg+xml;utf8,${PAGE_ICON_SVG}`;

// Hub icon: stack of three pages — visual "workspace root" affordance.
// Pages stack offset to suggest depth; topmost page is fully opaque and
// has the same dog-ear so the metaphor connects to the page-icon glyph.
const HUB_ICON_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    // Back page (most translucent) — slight rotation via offset
    '<path d="M5 7 a1 1 0 0 1 1 -1 h9 l3 3 v9 a1 1 0 0 1 -1 1 H6 a1 1 0 0 1 -1 -1 z" ' +
    'fill="rgba(255,255,255,0.45)"/>' +
    // Middle page — slightly opaque
    '<path d="M4 5 a1 1 0 0 1 1 -1 h9 l3 3 v9 a1 1 0 0 1 -1 1 H5 a1 1 0 0 1 -1 -1 z" ' +
    'fill="rgba(255,255,255,0.7)"/>' +
    // Front page — fully solid with dog-ear
    '<path d="M3 3 a1 1 0 0 1 1 -1 h9 l3 3 v9 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 z" ' +
    'fill="rgba(255,255,255,0.98)"/>' +
    '<path d="M13 2 V5 H16 z" fill="rgba(255,255,255,0.55)"/>' +
    // Two content lines on the front page
    '<rect x="6" y="9" width="6" height="1.2" rx="0.6" fill="rgba(0,0,0,0.4)"/>' +
    '<rect x="6" y="11.5" width="5" height="1.2" rx="0.6" fill="rgba(0,0,0,0.4)"/>' +
    '</svg>',
);
const HUB_ICON_URL = `data:image/svg+xml;utf8,${HUB_ICON_SVG}`;

// ─── Element builder ──────────────────────────────────────────────────────────

function buildElements(filtered: WikiGraphPayload): unknown[] {
  const out: unknown[] = [];
  for (const node of filtered.nodes) {
    const isChannel = node.data.kind === "channel";
    const isEntity = node.data.kind === "entity";
    const isWiki = node.data.kind === "wiki";
    const kindKey = kindKeyForNode(node);
    const color = colorForNode(node);
    // Cluster membership: fcose needs a string cluster id per node.
    // Channel hub gets its own cluster; wiki nodes cluster by kind.
    // Entity nodes cluster together.
    const clusterKey = isChannel
      ? "cluster_hub"
      : isEntity
        ? "cluster_entity"
        : `cluster_${kindKey}`;

    out.push({
      data: {
        ...node.data,
        displayLabel: buildLabel(node),
        color,
        kindKey,
        clusterKey,
        // Dimensions: bigger cards so titles are readable.
        // Channel hub: large octagonal disc.
        // Wiki page: 78×52 rounded card — fits ~22-char label at 12px.
        // Entity: small dot (not the focus of this view).
        nodeShape: isEntity ? "ellipse" : "round-rectangle",
        nodeWidth: isChannel ? 68 : isWiki ? 78 : 14,
        nodeHeight: isChannel ? 68 : isWiki ? 52 : 14,
        icon: isChannel ? HUB_ICON_URL : isWiki ? PAGE_ICON_URL : "",
        labelSize: isChannel ? 13 : isWiki ? 12 : 9,
        labelWeight: isChannel ? 700 : 500,
      },
    });
  }
  for (const edge of filtered.edges) {
    out.push({ data: { ...edge.data } });
  }
  return out;
}

// ─── Component types ──────────────────────────────────────────────────────────

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

// ─── WikiGraph ────────────────────────────────────────────────────────────────

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
  // Default fcose — best layout for clustered star graphs.
  const [layout, setLayout] = useState<LayoutKey>("fcose");

  // Floating filter panel state — starts open (matches MemoryGraphView default)
  const [filtersOpen, setFiltersOpen] = useState(true);
  // Search query — filters nodes by title match via cytoscape classes
  const [searchQuery, setSearchQuery] = useState("");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<unknown>(null);
  const [cytoscapeReady, setCytoscapeReady] = useState(false);
  const [cytoscapeError, setCytoscapeError] = useState<string | null>(null);
  const [selection, setSelection] = useState<WikiGraphSelectionData | null>(null);

  const filtered = useMemo(
    () => (data ? applyFilters(data, filters) : null),
    [data, filters],
  );

  // Selection handler in a ref — cytoscape mount effect never depends on it.
  const handleNodeTapRef = useRef<(nodeData: Record<string, unknown>) => void>(
    () => undefined,
  );
  handleNodeTapRef.current = useCallback((nodeData: Record<string, unknown>) => {
    if (!nodeData || !nodeData.id) {
      setSelection(null);
      return;
    }
    const fakeNode: WikiGraphNode = { data: nodeData as WikiGraphNode["data"] };
    const sel = selectionFromNode(fakeNode);
    if (sel.isEntity) {
      if (channelId) {
        const entityName = sel.id.startsWith("entity:")
          ? sel.id.slice(7)
          : sel.label;
        navigate(`/channels/${channelId}/memories?view=graph&entity=${encodeURIComponent(entityName)}`);
      }
      return;
    }
    setSelection(sel);
  }, [channelId, navigate]);

  const handleNodeDoubleTapRef = useRef<(nodeData: Record<string, unknown>) => void>(
    () => undefined,
  );
  handleNodeDoubleTapRef.current = useCallback(
    (nodeData: Record<string, unknown>) => {
      if (!nodeData || !nodeData.id || !channelId) return;
      const fakeNode: WikiGraphNode = { data: nodeData as WikiGraphNode["data"] };
      const sel = selectionFromNode(fakeNode);
      if (sel.isEntity || sel.isChannel || !sel.pageId) return;
      navigate(
        `/channels/${channelId}/wiki?page=${encodeURIComponent(sel.pageId)}`,
      );
    },
    [channelId, navigate],
  );

  const elements = useMemo(
    () => (filtered ? buildElements(filtered) : []),
    [filtered],
  );

  // ── Search: apply highlighted/dimmed classes whenever query changes ──────
  // This effect runs AFTER the graph is mounted and whenever searchQuery changes.
  useEffect(() => {
    const cy = cyRef.current as {
      elements: () => {
        removeClass: (c: string) => void;
        addClass?: (c: string) => void;
      };
      nodes: (sel?: string) => {
        forEach: (fn: (node: { data: (k: string) => unknown; addClass: (c: string) => void }) => void) => void;
        removeClass: (c: string) => void;
        addClass: (c: string) => void;
      };
      edges: () => { removeClass: (c: string) => void };
    } | null;
    if (!cy) return;
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      // Clear all search highlights
      try {
        cy.elements().removeClass("dimmed highlighted search-match");
      } catch { /* no-op */ }
      return;
    }
    // Dim everything, then highlight matches
    try {
      cy.elements().removeClass("dimmed highlighted search-match");
      // Dim all
      cy.nodes().addClass("dimmed");
      cy.edges().removeClass("dimmed");
      // Find matching nodes
      cy.nodes().forEach((node) => {
        const label = String(node.data("label") ?? node.data("displayLabel") ?? "").toLowerCase();
        if (label.includes(q)) {
          node.addClass("search-match");
          node.addClass("highlighted");
        }
      });
      // Un-dim matches
      cy.nodes("node.search-match").removeClass("dimmed");
    } catch { /* best-effort */ }
  }, [searchQuery]);

  // ── Main cytoscape mount effect ───────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    type CyTapEvent = {
      target: {
        id?: () => string;
        data?: () => Record<string, unknown>;
      };
    };
    type CyInstance = {
      on: {
        (event: string, handler: (e: CyTapEvent) => void): void;
        (event: string, selector: string, handler: (e: CyTapEvent) => void): void;
      };
      fit: (eles?: unknown, padding?: number) => void;
      zoom: (level?: number) => number;
      minZoom: (level: number) => void;
      maxZoom: (level: number) => void;
      container: () => HTMLElement;
      destroy: () => void;
    };
    let cy: CyInstance | null = null;
    if (!filtered || !containerRef.current) return;

    (async () => {
      try {
        const module = await import("cytoscape");
        if (!alive) return;
        const cytoscape = (module as { default: unknown }).default ?? module;

        // Register extensions — each wrapped in try/catch so one missing
        // module never blocks the graph from mounting.
        try {
          // @ts-expect-error — cytoscape-fcose has no .d.ts
          const fcose = (await import("cytoscape-fcose")).default;
          (cytoscape as { use: (ext: unknown) => void }).use(fcose);
        } catch { /* fcose already registered or missing */ }

        try {
          // @ts-expect-error — cytoscape-dagre has no .d.ts
          const dagre = (await import("cytoscape-dagre")).default;
          (cytoscape as { use: (ext: unknown) => void }).use(dagre);
        } catch { /* already registered */ }

        const factory = cytoscape as (config: Record<string, unknown>) => CyInstance;

        // ── Compute fcose cluster constraints ─────────────────────────────
        // Build one relativePlacementConstraint per kind cluster so fcose
        // pulls same-kind nodes together. This is the mechanism that creates
        // the "kind islands" in the galaxy layout.
        const clusterMap = new Map<string, string[]>();
        for (const el of elements) {
          const d = (el as { data: Record<string, unknown> }).data;
          if (d && d.clusterKey && d.id) {
            const key = String(d.clusterKey);
            const id = String(d.id);
            if (!clusterMap.has(key)) clusterMap.set(key, []);
            clusterMap.get(key)!.push(id);
          }
        }

        // fcose alignmentConstraint: nodes in the same cluster get pulled
        // together. We don't use relativePlacementConstraint here because
        // with 70 nodes it produces too rigid a grid. Instead we rely on
        // fcose's built-in clustering via high nodeRepulsion + low
        // idealEdgeLength per cluster.
        // The "clusters" param is an array of id-arrays.
        const clusters: string[][] = Array.from(clusterMap.values()).filter(
          (g) => g.length > 1,
        );

        cy = factory({
          container: containerRef.current,
          elements,
          wheelSensitivity: 0.2,
          style: [
            // ── Base node style ───────────────────────────────────────────
            {
              selector: "node",
              style: {
                shape: "data(nodeShape)" as unknown as "round-rectangle",
                label: "data(displayLabel)",
                "text-valign": "bottom",
                "text-halign": "center",
                "text-margin-y": 7,
                color: "#e2e8f0",
                "font-size": "data(labelSize)",
                "font-weight": "data(labelWeight)",
                "text-wrap": "wrap",
                "text-max-width": "100px",
                "text-outline-color": "#0f172a",
                "text-outline-width": 1.5,
                // Solid kind-color body. The previous attempt at a
                // gradient-ribbon (linear-gradient + data(color) stops)
                // crashed cytoscape's parser ("Cannot read properties
                // of null reading 'value'") because data() accessors
                // can't be interleaved with literal hex inside the
                // gradient stop arrays. Solid color reads just as
                // distinctly with the white-stroked icon on top.
                "background-color": "data(color)",
                "background-opacity": 0.92,
                "background-image": "data(icon)",
                "background-fit": "contain",
                "background-image-opacity": 0.95,
                "background-width": "45%",
                "background-height": "55%",
                width: "data(nodeWidth)" as unknown as number,
                height: "data(nodeHeight)" as unknown as number,
                "border-width": 1,
                "border-color": "rgba(255,255,255,0.10)",
                "corner-radius": 6,
                "transition-property": "opacity, border-color, border-width",
                "transition-duration": 150,
              } as unknown as cytoscape.Css.Node,
            },
            // ── Wiki page cards ───────────────────────────────────────────
            {
              selector: "node[kind = 'wiki']",
              style: {
                "border-width": 1,
                "border-color": "rgba(255,255,255,0.12)",
              },
            },
            // ── Channel hub ───────────────────────────────────────────────
            {
              selector: "node[kind = 'channel']",
              style: {
                // Hub is a solid purple disc — no ribbon, full color fill.
                "background-fill": "solid" as unknown as "solid",
                "background-color": "#7c3aed",
                "background-image": HUB_ICON_URL,
                "background-width": "55%",
                "background-height": "55%",
                "background-position-x": "50%",
                "border-width": 3,
                "border-color": "rgba(168,85,247,0.7)",
                "background-opacity": 1,
                color: "#faf5ff",
                "font-weight": 700,
                "font-size": 13,
                "corner-radius": 12,
              },
            },
            // ── Entity nodes ──────────────────────────────────────────────
            {
              selector: "node[kind = 'entity']",
              style: {
                "background-fill": "solid" as unknown as "solid",
                "background-color": "data(color)",
                "background-image": "none",
                "border-width": 1,
                "border-color": "rgba(255,255,255,0.18)",
              },
            },
            // ── Interaction states ────────────────────────────────────────
            {
              selector: "node.dimmed",
              style: { opacity: 0.2 },
            },
            {
              selector: "node.highlighted, node.search-match",
              style: {
                "border-width": 2.5,
                "border-color": "#fbbf24",
                "z-index": 999,
                opacity: 1,
              },
            },
            {
              selector: "node.neighbor",
              style: {
                "border-width": 2,
                "border-color": "#facc15",
                opacity: 1,
              },
            },
            {
              selector: "node:selected",
              style: {
                "border-color": "#fbbf24",
                "border-width": 2.5,
              },
            },
            {
              selector: "node:active",
              style: {
                "overlay-opacity": 0,
              },
            },
            // ── Edge styles ───────────────────────────────────────────────
            {
              selector: "edge",
              style: {
                width: 1.5,
                "line-color": "rgba(148,163,184,0.35)",
                "target-arrow-color": "rgba(148,163,184,0.45)",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
                "arrow-scale": 0.75,
                "transition-property": "line-color, opacity, width",
                "transition-duration": 150,
              },
            },
            { selector: "edge.dimmed", style: { opacity: 0.08 } },
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
              // Hub → page hierarchy — purple, subtle
              selector: "edge[kind = 'belongs_to']",
              style: {
                "line-color": "rgba(168,85,247,0.35)",
                "target-arrow-color": "rgba(168,85,247,0.5)",
                "line-style": "solid",
                width: 1,
              },
            },
            {
              // Parent → child (sub-topics) — sky blue
              selector: "edge[kind = 'child_of']",
              style: {
                "line-color": "rgba(96,165,250,0.6)",
                "target-arrow-color": "rgba(96,165,250,0.7)",
                "line-style": "solid",
                width: 1.8,
              },
            },
            {
              // [[wikilink]] cross-references — amber dashed
              selector: "edge[kind = 'references_wiki']",
              style: {
                "line-color": "rgba(251,191,36,0.55)",
                "target-arrow-color": "rgba(251,191,36,0.65)",
                "line-style": "dashed",
                width: 1.2,
              },
            },
            {
              // Entity refs — emerald dotted
              selector: "edge[kind = 'references_entity']",
              style: {
                "line-style": "dotted",
                "line-color": "rgba(16,185,129,0.45)",
                "target-arrow-color": "rgba(16,185,129,0.55)",
                width: 1,
              },
            },
          ],
          layout:
            layout === "fcose"
              ? {
                  name: "fcose",
                  quality: "default",
                  animate: true,
                  animationDuration: 800,
                  animationEasing: "ease-out-cubic",
                  fit: true,
                  padding: 100,
                  randomize: true,
                  // 78×52 wiki cards are MUCH bigger than entity-graph
                  // dots, so the same fcose params packed them into an
                  // overlapping blob. Critical knobs to fix that:
                  //   • nodeDimensionsIncludeLabels: true — fcose
                  //     reserves space for the actual rendered card,
                  //     not a point particle
                  //   • nodeSeparation: 80 — minimum pixel gap between
                  //     any two nodes
                  //   • nodeRepulsion 8k → 15k — stronger push
                  //   • idealEdgeLength 120 → 200 — longer edges =
                  //     looser inter-cluster spread
                  //   • clusterGravity 1.5 → 0.8 — clusters still pull
                  //     same-kind together but don't squeeze cards on
                  //     top of each other
                  nodeDimensionsIncludeLabels: true,
                  uniformNodeDimensions: false,
                  packComponents: true,
                  nodeSeparation: 80,
                  nodeRepulsion: () => 15000,
                  idealEdgeLength: () => 200,
                  edgeElasticity: () => 0.4,
                  gravity: 0.25,
                  gravityRange: 3.8,
                  numIter: 3000,
                  tile: true,
                  tilingPaddingHorizontal: 30,
                  tilingPaddingVertical: 30,
                  clusters: clusters.length > 0 ? clusters : undefined,
                  clusterGravity: 0.8,
                  clusterGravityRange: 0.9,
                }
              : layout === "dagre"
                ? {
                    name: "dagre",
                    rankDir: "TB",
                    animate: true,
                    animationDuration: 600,
                    animationEasing: "ease-out-cubic",
                    nodeSep: 110,
                    edgeSep: 40,
                    rankSep: 140,
                    fit: true,
                    padding: 50,
                  }
                : layout === "grid"
                  ? { name: "grid", animate: false, padding: 40 }
                  : {
                      name: "cose",
                      animate: false,
                      idealEdgeLength: 90,
                      nodeOverlap: 12,
                      nodeRepulsion: 400_000,
                      edgeElasticity: 80,
                      gravity: 0.4,
                      numIter: 1500,
                      padding: 50,
                      fit: true,
                    },
        });

        // ── Post-mount interaction wiring ─────────────────────────────────
        const cyAny = cy as unknown as {
          elements: () => {
            removeClass: (c: string) => void;
            addClass: (c: string) => void;
          };
          nodes: (sel?: string) => {
            forEach: (fn: (node: { data: (k: string) => unknown; addClass: (c: string) => void }) => void) => void;
            removeClass: (c: string) => void;
            addClass: (c: string) => void;
          };
          edges: () => { removeClass: (c: string) => void };
          getElementById: (id: string) => {
            length: number;
            data: () => Record<string, unknown>;
            closedNeighborhood: () => {
              removeClass: (c: string) => void;
              addClass: (c: string) => void;
              edges: () => { addClass: (c: string) => void };
            };
          };
          fit: (eles?: unknown, padding?: number) => void;
          zoom: (level?: number) => number;
          minZoom: (level: number) => void;
          maxZoom: (level: number) => void;
          container: () => HTMLElement;
        };

        cyAny.minZoom(0.25);
        cyAny.maxZoom(2.5);
        cyAny.fit(undefined, 70);
        const z = cyAny.zoom();
        if (z < 0.5) cyAny.zoom(0.5);

        try {
          cyAny.container().style.cursor = "default";
        } catch { /* no-op */ }

        const clearHighlights = () => {
          try {
            cyAny.elements().removeClass("dimmed highlighted neighbor");
          } catch { /* no-op */ }
        };

        // Node tap — highlight neighborhood + fire selection
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
          const nodeData = evtTarget.data();
          handleNodeTapRef.current(nodeData);
          try {
            cyAny.elements().removeClass("dimmed highlighted neighbor");
            cyAny.elements().addClass("dimmed");
            const neighborhood = evtTarget.closedNeighborhood();
            neighborhood.removeClass("dimmed");
            neighborhood.addClass("neighbor");
            neighborhood.edges().addClass("highlighted");
            const ele = cyAny.getElementById(evtTarget.id());
            if (ele.length > 0) {
              ele.closedNeighborhood().removeClass("dimmed");
            }
          } catch { /* highlight is best-effort */ }
        });

        // Background tap — clear selection
        cy.on("tap", (e) => {
          const evtTarget = (e as unknown as { target: unknown }).target;
          if (evtTarget === cy) {
            clearHighlights();
            handleNodeTapRef.current({});
          }
        });

        // Double-tap — navigate straight to wiki tab
        cy.on("dbltap", "node", (e) => {
          const data = (
            e as unknown as { target: { data: () => Record<string, unknown> } }
          ).target.data();
          handleNodeDoubleTapRef.current(data);
        });

        // Hover float — node grows ~10% over 180 ms ease-out, shrinks
        // back over 130 ms ease-in. Same pattern as the entity graph
        // for a consistent feel across the two surfaces. ``stop(true,
        // false)`` chains so rapid mouseover/out doesn't fight.
        cy.on("mouseover", "node", (e) => {
          try { cyAny.container().style.cursor = "pointer"; } catch { /* no-op */ }
          const node = (e as unknown as {
            target: {
              data: () => Record<string, unknown>;
              stop: (a: boolean, b: boolean) => { animate: (s: unknown, o: unknown) => void };
            };
          }).target;
          const baseW = (node.data().nodeWidth as number) ?? 0;
          const baseH = (node.data().nodeHeight as number) ?? 0;
          if (baseW > 0 && baseH > 0) {
            node.stop(true, false).animate(
              { style: { width: baseW * 1.1, height: baseH * 1.1 } },
              { duration: 180, easing: "ease-out-cubic" },
            );
          }
        });
        cy.on("mouseout", "node", (e) => {
          try { cyAny.container().style.cursor = "default"; } catch { /* no-op */ }
          const node = (e as unknown as {
            target: {
              data: () => Record<string, unknown>;
              stop: (a: boolean, b: boolean) => { animate: (s: unknown, o: unknown) => void };
            };
          }).target;
          const baseW = (node.data().nodeWidth as number) ?? 0;
          const baseH = (node.data().nodeHeight as number) ?? 0;
          if (baseW > 0 && baseH > 0) {
            node.stop(true, false).animate(
              { style: { width: baseW, height: baseH } },
              { duration: 130, easing: "ease-in-cubic" },
            );
          }
        });

        // Hub pulse — subtle breathing animation on the channel hub so
        // the eye knows where the workspace root is even when zoomed
        // out. Toggles +6% scale on a 1800 ms loop. Stops cleanly when
        // cytoscape is destroyed because the closure captures ``alive``.
        const hubPulse = () => {
          if (!alive || !cy) return;
          const hub = (cy as unknown as {
            $: (s: string) => { length: number; data: () => Record<string, unknown>; animate: (s: unknown, o: unknown) => void };
          }).$("node[kind = 'channel']");
          if (hub.length === 0) {
            window.setTimeout(hubPulse, 1800);
            return;
          }
          const baseW = (hub.data().nodeWidth as number) ?? 0;
          const baseH = (hub.data().nodeHeight as number) ?? 0;
          if (baseW <= 0 || baseH <= 0) return;
          hub.animate(
            { style: { width: baseW * 1.06, height: baseH * 1.06 } },
            {
              duration: 900,
              easing: "ease-in-out-cubic",
              complete: () => {
                if (!alive || !cy) return;
                hub.animate(
                  { style: { width: baseW, height: baseH } },
                  {
                    duration: 900,
                    easing: "ease-in-out-cubic",
                    complete: () => {
                      if (!alive) return;
                      window.setTimeout(hubPulse, 600);
                    },
                  },
                );
              },
            },
          );
        };
        // Kick off the pulse after the layout settles so it doesn't
        // fight the initial fcose animation.
        window.setTimeout(hubPulse, 1200);

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
      try { if (cy) cy.destroy(); } catch { /* destroy is best-effort */ }
      cyRef.current = null;
    };
    // handleNodeTapRef intentionally absent — ref.current updated above.
  }, [elements, layout]);

  // Resize canvas when panel opens/closes
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      const cy = cyRef.current as
        | { resize: () => void; fit: (eles?: unknown, padding?: number) => void }
        | null;
      if (!cy) return;
      try {
        cy.resize();
        cy.fit(undefined, 70);
      } catch { /* no-op */ }
    });
    return () => window.cancelAnimationFrame(handle);
  }, [selection !== null]);

  // ── Available kinds for the floating panel ─────────────────────────────────
  const availableKinds = useMemo<KindFilter[]>(() => {
    if (!data) return ["all"];
    const kinds = new Set<KindFilter>(["all"]);
    for (const n of data.nodes) {
      if (n.data.kind === "entity") kinds.add("entity");
      else if (n.data.kind === "wiki") {
        const pk = n.data.page_kind;
        if (pk === "topic") kinds.add("topic");
        if (pk === "decisions") kinds.add("decisions");
        if (pk === "faq") kinds.add("faq");
        if (pk === "action_items") kinds.add("action_items");
      }
    }
    return Array.from(kinds);
  }, [data]);

  return (
    <div className="flex h-full flex-col" data-testid="wiki-graph-root">
      {/* No top filter strip — filters live in the floating left panel. */}

      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {/* Canvas */}
        <div className="relative flex-1 min-w-0 overflow-hidden bg-slate-950/60">
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

        {/* Detail panel */}
        {selection && (
          <WikiGraphPanel
            channelId={channelId}
            selection={selection}
            onClose={() => setSelection(null)}
          />
        )}

        {/* ── Floating filter panel (left) ──────────────────────────── */}
        <div className="absolute left-3 top-1/2 -translate-y-1/2 z-20">
          {!filtersOpen ? (
            // Collapsed pill
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border border-border/60",
                "bg-card/85 backdrop-blur-sm px-2 py-3 shadow-sm",
                "text-muted-foreground hover:text-foreground hover:bg-card transition-colors",
              )}
              aria-label="Open graph filters"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span
                className="text-[9px] font-medium tracking-wider uppercase text-muted-foreground/70"
                style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
              >
                Filters
              </span>
              {(filters.kind !== "all" || searchQuery) && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground leading-none">
                  !
                </span>
              )}
            </button>
          ) : (
            // Expanded panel
            <div
              className={cn(
                "flex flex-col gap-2.5 rounded-xl border border-border/60",
                "bg-card/95 backdrop-blur-sm shadow-lg p-3 w-[172px]",
              )}
            >
              {/* Header row */}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  <SlidersHorizontal className="w-3 h-3" />
                  Filters
                </span>
                <button
                  type="button"
                  onClick={() => setFiltersOpen(false)}
                  className="text-muted-foreground/50 hover:text-foreground transition-colors"
                  aria-label="Close filters"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Search box */}
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search pages…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={cn(
                    "w-full rounded-lg border border-border/50 bg-background/60 pl-6 pr-2 py-1",
                    "text-[11px] text-foreground placeholder:text-muted-foreground/50",
                    "focus:outline-none focus:border-border focus:bg-background",
                    "transition-colors",
                  )}
                  aria-label="Search wiki pages"
                />
              </div>

              <div className="border-t border-border/30" />

              {/* Kind filter */}
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-0.5">
                  Kind
                </span>
                {/* Hidden select preserves the data-testid contract for tests */}
                <select
                  aria-label="Filter by page kind"
                  value={filters.kind}
                  onChange={(e) => {
                    setFilters((s) => ({ ...s, kind: e.target.value as KindFilter }));
                  }}
                  className="sr-only"
                  data-testid="wiki-graph-filter-kind"
                >
                  <option value="all">All kinds</option>
                  <option value="topic">Topic</option>
                  <option value="entity">Entity</option>
                  <option value="decisions">Decisions</option>
                  <option value="faq">FAQ</option>
                  <option value="action_items">Action items</option>
                </select>
                {/* Visual kind buttons */}
                {(["all", "topic", "entity", "decisions", "faq", "action_items"] as KindFilter[])
                  .filter((k) => k === "all" || availableKinds.includes(k))
                  .map((k) => {
                    const active = filters.kind === k;
                    const kindColorMap: Record<string, string> = {
                      all: "#94a3b8",
                      topic: KIND_META.wiki_topic.color,
                      entity: KIND_META.entity.color,
                      decisions: KIND_META.wiki_decisions.color,
                      faq: KIND_META.wiki_faq.color,
                      action_items: KIND_META.wiki_action_items.color,
                    };
                    const kindLabelMap: Record<string, string> = {
                      all: "All kinds",
                      topic: "Topics",
                      entity: "Entities",
                      decisions: "Decisions",
                      faq: "FAQ",
                      action_items: "Actions",
                    };
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setFilters((s) => ({ ...s, kind: k }))}
                        className={cn(
                          "inline-flex items-center gap-2 px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors w-full text-left",
                          active
                            ? "border-border/70 text-foreground bg-muted"
                            : "border-border/40 text-muted-foreground/60 bg-transparent hover:border-border hover:text-foreground",
                        )}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0 transition-colors"
                          style={{ backgroundColor: active ? kindColorMap[k] : undefined }}
                        />
                        {kindLabelMap[k]}
                      </button>
                    );
                  })}
              </div>

              <div className="border-t border-border/30" />

              {/* Time window */}
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-0.5">
                  Updated
                </span>
                {(["all", "1h", "24h", "7d"] as WindowFilter[]).map((w) => {
                  const active = filters.touchedWithin === w;
                  const labelMap = { all: "Any time", "1h": "Last hour", "24h": "Last 24h", "7d": "Last 7d" };
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setFilters((s) => ({ ...s, touchedWithin: w }))}
                      className={cn(
                        "inline-flex items-center gap-2 px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors w-full text-left",
                        active
                          ? "border-border/70 text-foreground bg-muted"
                          : "border-border/40 text-muted-foreground/60 bg-transparent hover:border-border hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0 transition-colors",
                          active ? "bg-muted-foreground" : "bg-transparent",
                        )}
                      />
                      {labelMap[w]}
                    </button>
                  );
                })}
              </div>

              <div className="border-t border-border/30" />

              {/* Citation density */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  Min citations: {filters.minCitations}
                </span>
                <input
                  aria-label="Minimum citation density"
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={filters.minCitations}
                  onChange={(e) =>
                    setFilters((s) => ({
                      ...s,
                      minCitations: parseInt(e.target.value, 10),
                    }))
                  }
                  className="w-full accent-primary h-1 rounded-full"
                />
              </div>

              <div className="border-t border-border/30" />

              {/* Layout switcher */}
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-0.5">
                  Layout
                </span>
                {(["fcose", "dagre", "cose", "grid"] as LayoutKey[]).map((l) => {
                  const active = layout === l;
                  const labelMap: Record<LayoutKey, string> = {
                    fcose: "Clusters",
                    dagre: "Top-down",
                    cose: "Force",
                    grid: "Grid",
                  };
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setLayout(l)}
                      className={cn(
                        "inline-flex items-center gap-2 px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors w-full text-left",
                        active
                          ? "border-border/70 text-foreground bg-muted"
                          : "border-border/40 text-muted-foreground/60 bg-transparent hover:border-border hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          active ? "bg-primary" : "bg-transparent",
                        )}
                      />
                      {labelMap[l]}
                    </button>
                  );
                })}
              </div>

              <div className="border-t border-border/30" />

              {/* Refresh */}
              <button
                type="button"
                onClick={() => refetch()}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border/50 bg-background/50 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                Refresh graph
              </button>
            </div>
          )}
        </div>
        {/* ── End floating filter panel ─────────────────────────────── */}

        {/* ── Legend (bottom-right overlay) ────────────────────────── */}
        <div className="absolute bottom-8 right-4 z-10">
          <Legend />
        </div>
      </div>

      {/* Footer */}
      <footer className="flex items-center justify-between border-t border-border bg-card/60 px-5 py-2 text-xs text-muted-foreground shrink-0">
        <span>
          {filtered?.nodes.length ?? 0} nodes · {filtered?.edges.length ?? 0} edges
          {searchQuery && (
            <>
              {" · "}
              <span className="text-amber-400">searching "{searchQuery}"</span>
            </>
          )}
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

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  const items: Array<{ color: string; label: string }> = [
    { color: KIND_META.channel.color, label: "Hub" },
    { color: KIND_META.wiki_overview.color, label: "Overview" },
    { color: KIND_META.wiki_topic.color, label: "Topic" },
    { color: KIND_META.wiki_subtopic.color, label: "Sub-topic" },
    { color: KIND_META.wiki_decisions.color, label: "Decisions" },
    { color: KIND_META.wiki_faq.color, label: "FAQ" },
    { color: KIND_META.wiki_action_items.color, label: "Actions" },
    { color: KIND_META.entity.color, label: "Entity" },
  ];
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/40 bg-card/80 backdrop-blur-sm px-3 py-2">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className="inline-block h-2 w-2 rounded-sm shrink-0"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// ─── WikiGraphPanel ───────────────────────────────────────────────────────────

interface WikiGraphPanelProps {
  channelId?: string;
  selection: WikiGraphSelectionData;
  onClose: () => void;
}

function WikiGraphPanel({ channelId, selection, onClose }: WikiGraphPanelProps) {
  const navigate = useNavigate();
  const wantsPageFetch = !selection.isChannel && !selection.isEntity && !!selection.pageId;
  const {
    data: page,
    isLoading: isPageLoading,
  } = useWikiPage(
    wantsPageFetch ? channelId : undefined,
    wantsPageFetch ? selection.pageId : undefined,
  );
  const goToWikiPage = () => {
    if (!channelId || !selection.pageId) return;
    navigate(
      `/channels/${channelId}/wiki?page=${encodeURIComponent(selection.pageId)}`,
    );
  };

  const wide = wantsPageFetch && (page || isPageLoading);
  const widthClass = wide ? "w-[28rem] lg:w-[34rem]" : "w-80";

  return (
    <aside
      className={`${widthClass} shrink-0 border-l border-border bg-card/95 overflow-y-auto shadow-2xl backdrop-blur-sm`}
      role="complementary"
      aria-label="Wiki graph node details"
      data-testid="wiki-graph-panel"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card/95 px-4 py-3 backdrop-blur-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {selection.isChannel
            ? "Channel hub"
            : selection.isEntity
              ? "Entity"
              : "Wiki page"}
        </span>
        <div className="flex items-center gap-1">
          {!selection.isChannel && !selection.isEntity && selection.pageId && (
            <button
              type="button"
              onClick={goToWikiPage}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
              aria-label="Open in Wiki tab"
              title="Open this page in the wiki tab (or double-click the node)"
            >
              <ExternalLink size={11} />
              Open in Wiki
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            aria-label="Close preview"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="space-y-3 px-4 py-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground leading-tight">
            {selection.label}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {selection.sectionNumber && (
              <span>§{selection.sectionNumber}</span>
            )}
            {selection.pageKind && !selection.isChannel && !selection.isEntity && (
              <span className="capitalize">{selection.pageKind}</span>
            )}
            {typeof selection.memoryCount === "number" && selection.memoryCount > 0 && (
              <span>{selection.memoryCount} memories</span>
            )}
            {selection.lastUpdated && (
              <span title={selection.lastUpdated}>
                Updated {new Date(selection.lastUpdated).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>

        {wantsPageFetch && (
          <div data-testid="wiki-graph-panel-content">
            {isPageLoading && (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                Loading page…
              </div>
            )}
            {!isPageLoading && page && page.content && (
              <div className="prose prose-sm dark:prose-invert max-w-none [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs">
                <WikiMarkdown
                  content={page.content}
                  citations={page.citations ?? []}
                />
              </div>
            )}
            {!isPageLoading && !page && selection.summary && (
              <p className="text-sm text-foreground/80 leading-relaxed">
                {selection.summary}
              </p>
            )}
            {!isPageLoading && !page && !selection.summary && (
              <p className="text-xs text-muted-foreground italic">
                Page content unavailable. Try the Wiki tab for the latest
                version.
              </p>
            )}
          </div>
        )}

        {!wantsPageFetch && selection.summary && (
          <p className="text-sm text-foreground/80 leading-relaxed">
            {selection.summary}
          </p>
        )}
      </div>
    </aside>
  );
}

export default WikiGraph;
