import { useState, useEffect, Suspense, lazy } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { FolderSync, Loader2, Network, Sparkles } from "lucide-react";
import { useGraph } from "@/hooks/useGraph";
import { useChannelMemoryCount } from "@/hooks/useChannelMemoryCount";
import { PipelineEmptyState } from "@/components/shared/PipelineEmptyState";
import { GraphFilters } from "./GraphFilters";
import { GraphCanvas } from "./GraphCanvas";
import { EntityPanel } from "./EntityPanel";
import { MediaModal } from "./MediaModal";

// Lazy-load the wiki graph so cytoscape stays out of the entity-graph
// view's bundle until the operator toggles to ``?view=wiki``. The
// `/channels/:id/wiki/graph` route still mounts the same component for
// direct deep-links from the wiki tab's Tools menu.
const WikiGraph = lazy(() => import("@/components/wiki/WikiGraph"));

const MEDIA_TYPES = new Set(["Link", "Document", "Image", "Media"]);

export function GraphTab() {
  const { id: channelId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  // URL-stateful view toggle so refreshing the page or sharing a link
  // preserves the operator's chosen view (entities vs wiki).
  const view: "entities" | "wiki" =
    searchParams.get("view") === "wiki" ? "wiki" : "entities";
  const setView = (next: "entities" | "wiki") => {
    const updated = new URLSearchParams(searchParams);
    if (next === "entities") {
      updated.delete("view");
    } else {
      updated.set("view", next);
    }
    setSearchParams(updated, { replace: true });
  };
  const { entities, relationships, loading, error } = useGraph(channelId ?? "");
  const { hasMemories, isLoading: isMemoryCountLoading } = useChannelMemoryCount(channelId);
  const [visibleTypes, setVisibleTypes] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mediaModal, setMediaModal] = useState<{ name: string; url: string; mediaType: string } | null>(null);

  // Derive entity types from data; keep all visible when types change
  const entityTypes = [...new Set(entities.map((e) => e.type))].sort();

  useEffect(() => {
    setVisibleTypes(entityTypes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities]);

  const selectedEntity = selectedId
    ? entities.find((e) => e.id === selectedId) ?? null
    : null;

  // When a media-type node is selected, open the modal
  const handleSelectEntity = (id: string | null) => {
    if (id) {
      const entity = entities.find((e) => e.id === id);
      if (entity) {
        const props = entity.properties as Record<string, unknown> | undefined;
        const url = (props?.url as string) || "";
        const mediaType = (props?.media_type as string) || entity.type.toLowerCase();
        if (url && (MEDIA_TYPES.has(entity.type) || mediaType)) {
          setMediaModal({ name: entity.name, url, mediaType });
          return;
        }
      }
    }
    setSelectedId(id);
  };

  // ---- view toggle ---------------------------------------------------
  const ViewToggle = (
    <div
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card p-0.5"
      role="tablist"
      aria-label="Graph view"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === "entities"}
        onClick={() => setView("entities")}
        className={
          "rounded px-3 py-1 text-xs font-medium transition-colors " +
          (view === "entities"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-muted")
        }
      >
        Entities
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "wiki"}
        onClick={() => setView("wiki")}
        className={
          "rounded px-3 py-1 text-xs font-medium transition-colors " +
          (view === "wiki"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-muted")
        }
      >
        Wiki
      </button>
    </div>
  );

  if (view === "wiki") {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center justify-between border-b border-border bg-card/60 px-5 py-2">
          <h2 className="text-sm font-semibold text-foreground">Wiki cross-link graph</h2>
          {ViewToggle}
        </div>
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full p-6">
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="w-6 h-6 animate-spin" />
                <span className="text-sm">Loading wiki graph view…</span>
              </div>
            </div>
          }
        >
          <WikiGraph channelId={channelId} />
        </Suspense>
      </div>
    );
  }

  // ---- entities (default) view --------------------------------------

  if (loading) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center justify-end border-b border-border bg-card/60 px-5 py-2">
          {ViewToggle}
        </div>
        <div className="flex items-center justify-center h-full p-6">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="text-sm">Loading graph...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center justify-end border-b border-border bg-card/60 px-5 py-2">
          {ViewToggle}
        </div>
        <div className="flex items-center justify-center h-full p-6">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  if (entities.length === 0 && !isMemoryCountLoading) {
    const isNoMemory = !hasMemories;
    const steps = [
      { label: "Sync channel", icon: FolderSync, done: !isNoMemory, active: isNoMemory },
      { label: "Build memories", icon: Sparkles, done: !isNoMemory, active: false },
      { label: "View graph", icon: Network, done: false, active: !isNoMemory },
    ];
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center justify-end border-b border-border bg-card/60 px-5 py-2">
          {ViewToggle}
        </div>
        <PipelineEmptyState
          icon={isNoMemory ? FolderSync : Network}
          title={isNoMemory ? "Sync this channel first" : "No entities yet"}
          description={
            isNoMemory
              ? "The graph visualizes entities extracted from channel memories. Sync this channel to unlock it."
              : "Entities will appear here once this channel's memories are consolidated into a knowledge graph."
          }
          steps={steps}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-border bg-card/60 px-5 py-2">
        <GraphFilters entityTypes={entityTypes} selected={visibleTypes} onChange={setVisibleTypes} />
        {ViewToggle}
      </div>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <GraphCanvas
          entities={entities}
          relationships={relationships}
          visibleTypes={visibleTypes}
          selectedEntityId={selectedId}
          onSelectEntity={handleSelectEntity}
        />
        {selectedEntity && (
          <EntityPanel
            entity={selectedEntity}
            relationships={relationships}
            allEntities={entities}
            channelId={channelId ?? ""}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
      {mediaModal && (
        <MediaModal
          name={mediaModal.name}
          url={mediaModal.url}
          mediaType={mediaModal.mediaType}
          onClose={() => setMediaModal(null)}
        />
      )}
    </div>
  );
}
