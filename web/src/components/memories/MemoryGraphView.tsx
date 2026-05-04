import { useEffect, useState } from "react";
import { FolderSync, Loader2, Network, Sparkles } from "lucide-react";
import { useGraph } from "@/hooks/useGraph";
import { useChannelMemoryCount } from "@/hooks/useChannelMemoryCount";
import { PipelineEmptyState } from "@/components/shared/PipelineEmptyState";
import { GraphFilters } from "@/components/graph/GraphFilters";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { EntityPanel } from "@/components/graph/EntityPanel";
import { MediaModal } from "@/components/graph/MediaModal";
import { FullscreenWrapper } from "@/components/shared/FullscreenWrapper";

const MEDIA_TYPES = new Set(["Link", "Document", "Image", "Media"]);

interface Props {
  channelId: string;
}

/**
 * Entity knowledge graph rendering — moved out of the standalone
 * GraphTab into a delegate that the Agent Memory tab mounts when
 * ``?view=graph`` is on the URL. Owns the cytoscape data + selection
 * + media-modal state; the parent (TierBrowser) handles the
 * Memory↔Graph view toggle in its own header.
 */
export function MemoryGraphView({ channelId }: Props) {
  const { entities, relationships, loading, error } = useGraph(channelId);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin" />
          <span className="text-sm">Loading graph...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <p className="text-sm text-destructive">{error}</p>
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
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* No border on this strip — TierBrowser already owns a border-b
          on the segmented-toggle strip directly above. Stacking two
          rules creates visual double-vision. The filter row reads as
          a quieter sub-header to the toggle. */}
      <div className="flex items-center bg-card/60 px-5 py-1.5 border-b border-border/50">
        <GraphFilters entityTypes={entityTypes} selected={visibleTypes} onChange={setVisibleTypes} />
      </div>
      {/* Wrap the canvas + selection panel so Enlarge spans both. The
          wrapper takes care of the fullscreen overlay; cytoscape's
          ResizeObserver in GraphCanvas handles the layout reflow. */}
      <FullscreenWrapper label="Enlarge graph" className="flex-1 min-h-0">
        <div className="flex h-full w-full min-h-0 overflow-hidden">
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
              channelId={channelId}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      </FullscreenWrapper>
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
