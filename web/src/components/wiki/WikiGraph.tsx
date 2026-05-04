/**
 * Wiki graph view — renders the channel's WikiPage + Entity nodes and
 * their REFERENCES edges via Cytoscape.js.
 *
 * Cytoscape is loaded ONLY at mount time via dynamic ``import()`` so
 * the wiki tab's main bundle never pays its weight (§6.13). Until the
 * dynamic import resolves, a lightweight skeleton shows in place of
 * the canvas.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWikiGraph, type WikiGraphPayload } from "@/hooks/useWikiGraph";

type LayoutKey = "cose-bilkent" | "dagre" | "grid";
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
    if (filters.kind === "all") return true;
    if (filters.kind === "entity") return n.data.kind === "entity";
    // Wiki-page kinds: topic / decisions / faq / etc.
    if (n.data.kind !== "wiki") return false;
    return n.data.page_kind === filters.kind;
  });

  // Citation density filter — count incoming edges per node and keep
  // those at or above the threshold (or always keep entities since
  // they don't have a meaningful "citation count").
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
  const [layout, setLayout] = useState<LayoutKey>("cose-bilkent");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<unknown>(null);
  const [cytoscapeReady, setCytoscapeReady] = useState(false);
  const [cytoscapeError, setCytoscapeError] = useState<string | null>(null);

  const filtered = useMemo(
    () => (data ? applyFilters(data, filters) : null),
    [data, filters],
  );

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (!channelId) return;
      if (nodeId.startsWith("entity:")) {
        // Entity nodes navigate to the existing entity-graph route.
        navigate(`/channels/${channelId}/graph?entity=${encodeURIComponent(nodeId.slice(7))}`);
        return;
      }
      navigate(`/channels/${channelId}/wiki/pages/${nodeId}`);
    },
    [channelId, navigate],
  );

  // Lazy-load cytoscape ONCE — the dynamic import keeps it out of the
  // wiki tab's main bundle.
  useEffect(() => {
    let alive = true;
    let cy: { destroy: () => void } | null = null;
    if (!filtered || !containerRef.current) return;

    (async () => {
      try {
        const module = await import("cytoscape");
        if (!alive) return;
        const cytoscape = (module as { default: unknown }).default ?? module;
        const factory = cytoscape as (config: Record<string, unknown>) => {
          on: (event: string, selector: string, handler: (e: unknown) => void) => void;
          destroy: () => void;
        };
        cy = factory({
          container: containerRef.current,
          elements: [...filtered.nodes, ...filtered.edges],
          style: [
            {
              selector: "node",
              style: {
                label: "data(label)",
                "font-size": 10,
                "background-color": "#3b82f6",
                width: 24,
                height: 24,
                "text-valign": "bottom",
                "text-margin-y": 4,
                color: "#374151",
              },
            },
            {
              selector: "node[kind = 'entity']",
              style: { "background-color": "#10b981" },
            },
            {
              selector: "edge",
              style: {
                width: 1.5,
                "line-color": "#94a3b8",
                "target-arrow-color": "#94a3b8",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
              },
            },
            {
              selector: "edge[kind = 'references_entity']",
              style: { "line-style": "dashed", "line-color": "#10b981" },
            },
          ],
          layout: {
            name: layout === "cose-bilkent" ? "cose" : layout,
            animate: false,
          },
        });
        const cyTyped = cy as unknown as {
          on: (event: string, selector: string, handler: (e: { target: { id: () => string } }) => void) => void;
          destroy: () => void;
        };
        cyTyped.on("tap", "node", (e) => {
          handleNodeClick(e.target.id());
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
  }, [filtered, layout, handleNodeClick]);

  return (
    <div className="flex h-full flex-col" data-testid="wiki-graph-root">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card/60 px-5 py-3">
        <h2 className="text-base font-semibold text-foreground">Wiki graph</h2>
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
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
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
          <option value="cose-bilkent">cose-bilkent</option>
          <option value="dagre">dagre</option>
          <option value="grid">grid</option>
        </select>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
        >
          Refresh
        </button>
      </header>

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

      <footer className="flex items-center justify-between border-t border-border bg-card/60 px-5 py-2 text-xs text-muted-foreground">
        <span>
          {filtered?.nodes.length ?? 0} nodes · {filtered?.edges.length ?? 0} edges
        </span>
        <span className="opacity-70">channel {channelId}</span>
      </footer>
    </div>
  );
}

export default WikiGraph;
