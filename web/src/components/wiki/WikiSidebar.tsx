import { useState, useMemo, type ComponentType } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  BookOpen,
  HelpCircle,
  BookText,
  Users,
  Clock,
  Library,
  FileText,
} from "lucide-react";
import type { WikiPageNode } from "@/lib/types";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { wikiT } from "@/lib/wikiI18n";

// Map a fixed-page slug/id to a recognizable icon. Fixed pages are
// always-present sections like Overview, FAQ, Glossary, etc. Operators
// scan for the icon faster than the numeric prefix that would
// otherwise lead the row.
type LucideIcon = ComponentType<{ className?: string; size?: number }>;

// Renumber topic section_numbers for sidebar display.
//
// The wiki generator numbers Overview as "1", Topics as "2.X" (so 2.1,
// 2.2, …, 2.21), then other fixed pages as "3", "4", "5", etc. Now that
// fixed pages are rendered with icons (their section numbers don't
// appear in the sidebar at all), the visible numeric column starts at
// "2.1" — which reads oddly as "where's 1.X?". Strip the leading "2"
// so topics display as 1.1, 1.2, …, 1.21 — the only numeric hierarchy
// the operator sees.
function displaySectionNumber(num: string): string {
  if (!num) return num;
  if (num === "2") return "1";
  if (num.startsWith("2.")) return "1" + num.slice(1);
  return num;
}

function iconForFixedPage(node: WikiPageNode): LucideIcon {
  const key = (node.slug || node.id || "").toLowerCase();
  if (key.includes("overview")) return BookOpen;
  if (key.includes("faq")) return HelpCircle;
  if (key.includes("glossary")) return BookText;
  if (key.includes("people") || key.includes("expert") || key.includes("member"))
    return Users;
  if (key.includes("activity") || key.includes("recent") || key.includes("timeline"))
    return Clock;
  if (key.includes("resource") || key.includes("media") || key.includes("link"))
    return Library;
  return FileText;
}

interface WikiSidebarProps {
  pages: WikiPageNode[];
  activePageId: string;
  onNavigate: (pageId: string) => void;
  lang?: string;
}

interface SidebarItemProps {
  node: WikiPageNode;
  isActive: boolean;
  onClick: () => void;
  indent?: number;
  /** Display title override — used when an item lives inside a
   *  prefix-group and the common prefix has been stripped. */
  displayTitle?: string;
}

function SidebarItem({ node, isActive, onClick, indent = 0, displayTitle }: SidebarItemProps) {
  const fullTitle = [node.section_number, node.title].filter(Boolean).join(" ");
  const shownTitle = displayTitle ?? node.title;
  // Fixed pages (Overview, FAQ, Glossary, People & Experts, Recent
  // Activity, Resources & Media) lead with a recognizable icon instead
  // of a numeric prefix. Folder pages (planner-produced) use the
  // Folder icon. The numeric structure is reserved for topics and
  // sub-topics where it carries real semantic meaning (2.1, 2.21).
  const isFixed = node.page_type === "fixed";
  const isBackendFolder = node.page_type === "folder";
  const FixedIcon = isFixed ? iconForFixedPage(node) : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            onClick={onClick}
            aria-label={fullTitle}
            className={`group/row relative flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              isActive
                ? "bg-primary/10 text-primary border-l-2 border-primary font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            style={{ paddingLeft: `${10 + indent * 14}px` }}
          >
            {FixedIcon ? (
              <span className="shrink-0 flex h-5 w-7 items-center justify-center text-muted-foreground/75">
                <FixedIcon size={14} />
              </span>
            ) : isBackendFolder ? (
              <span className="shrink-0 flex h-5 w-7 items-center justify-center text-primary/75">
                <Folder size={14} />
              </span>
            ) : (
              /* Section number leads for topics — eye scans by number
                 first. Tooltip carries the full title for ambiguous
                 truncations. */
              <span className="text-[11px] text-muted-foreground/80 font-mono font-semibold shrink-0 tabular-nums">
                {displaySectionNumber(node.section_number)}
              </span>
            )}
            <span className="truncate flex-1">{shownTitle}</span>
            {/* Memory count — hidden by default (display:none, no
                layout slot reserved), revealed on row hover. Using
                ``hidden`` instead of ``opacity-0`` is critical: the
                opacity approach kept the right-side slot reserved and
                forced the title to truncate ~40px earlier than it had
                to. With display:none the title can use the full row
                width when not hovered, and the count overlays via
                absolute positioning on hover so the title doesn't
                shift when it appears. */}
            {node.memory_count > 0 && (
              <span className="hidden group-hover/row:inline absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground/70 tabular-nums bg-muted/95 backdrop-blur-sm px-1.5 py-0.5 rounded">
                {node.memory_count} memories
              </span>
            )}
          </button>
        }
      />
      <TooltipContent side="right" className="text-xs max-w-xs">
        {fullTitle}
        {node.memory_count > 0 && (
          <span className="ml-1 text-muted-foreground/70">· {node.memory_count} memories</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** Check if any descendant of a node matches the active page ID */
function hasActiveChild(node: WikiPageNode, activePageId: string): boolean {
  for (const child of node.children) {
    if (child.id === activePageId) return true;
    if (hasActiveChild(child, activePageId)) return true;
  }
  return false;
}

interface TopicItemWithChildrenProps {
  node: WikiPageNode;
  activePageId: string;
  onNavigate: (pageId: string) => void;
  indent: number;
  displayTitle?: string;
}

function TopicItemWithChildren({
  node,
  activePageId,
  onNavigate,
  indent,
  displayTitle,
}: TopicItemWithChildrenProps) {
  const isActive = activePageId === node.id;
  const hasChildren = node.children.length > 0;
  const childIsActive = hasActiveChild(node, activePageId);
  const [userExpanded, setUserExpanded] = useState(false);
  const expanded = childIsActive || userExpanded;

  return (
    <div>
      <div className="flex items-center">
        {hasChildren && (
          <button
            onClick={() => setUserExpanded((prev) => !prev)}
            className="p-0.5 text-muted-foreground/60 hover:text-foreground shrink-0"
            style={{ marginLeft: `${6 + indent * 14}px` }}
            aria-label={expanded ? "Collapse sub-topics" : "Expand sub-topics"}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        )}
        <div className="flex-1 min-w-0">
          <SidebarItem
            node={node}
            isActive={isActive}
            onClick={() => onNavigate(node.id)}
            indent={hasChildren ? 0 : indent + 1}
            displayTitle={displayTitle}
          />
        </div>
      </div>
      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <SidebarItem
              key={child.id}
              node={child}
              isActive={activePageId === child.id}
              onClick={() => onNavigate(child.id)}
              indent={indent + 2}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Heuristic prefix-grouping for adjacent topic siblings.
 *
 * When 3+ adjacent topic pages share a multi-word prefix (e.g.
 * "Beever Atlas Documentation", "Beever Atlas GitHub Repository",
 * "Beever Atlas GitHub Star Growth Campaign"), the user's eye sees
 * "Beever Atlas..." 10 times in a row and can't tell them apart.
 *
 * Group them under a synthetic collapsible cluster labelled with the
 * shared prefix; each child item displays only its differentiating
 * tail. The user expands the cluster to access the items.
 */
type SidebarRow =
  | { kind: "item"; node: WikiPageNode }
  | { kind: "group"; prefix: string; items: WikiPageNode[]; key: string };

function commonWordPrefix(a: string, b: string): string {
  const wa = a.split(/\s+/);
  const wb = b.split(/\s+/);
  const out: string[] = [];
  const lim = Math.min(wa.length, wb.length);
  for (let i = 0; i < lim; i++) {
    if (wa[i].toLowerCase() === wb[i].toLowerCase()) {
      out.push(wa[i]);
    } else {
      break;
    }
  }
  return out.join(" ");
}

function groupByPrefix(nodes: WikiPageNode[]): SidebarRow[] {
  const out: SidebarRow[] = [];
  let i = 0;
  while (i < nodes.length) {
    // Look ahead to find the longest run with a 2+ word common prefix.
    let runEnd = i;
    let prefix = "";
    if (i + 1 < nodes.length) {
      let candidatePrefix = commonWordPrefix(nodes[i].title, nodes[i + 1].title);
      if (candidatePrefix.split(/\s+/).filter(Boolean).length >= 2) {
        // Extend the run while neighbors keep matching the (possibly
        // shrinking) common prefix.
        runEnd = i + 1;
        prefix = candidatePrefix;
        for (let j = i + 2; j < nodes.length; j++) {
          const next = commonWordPrefix(prefix, nodes[j].title);
          if (next.split(/\s+/).filter(Boolean).length >= 2) {
            prefix = next;
            runEnd = j;
          } else {
            break;
          }
        }
      }
    }
    // Need at least 3 items in the run for grouping to pay off; below
    // that the chrome of the cluster row costs more than it saves.
    if (runEnd - i >= 2) {
      out.push({
        kind: "group",
        prefix,
        items: nodes.slice(i, runEnd + 1),
        key: `grp:${prefix}:${nodes[i].id}`,
      });
      i = runEnd + 1;
    } else {
      out.push({ kind: "item", node: nodes[i] });
      i += 1;
    }
  }
  return out;
}

interface PrefixGroupProps {
  prefix: string;
  items: WikiPageNode[];
  activePageId: string;
  onNavigate: (pageId: string) => void;
  indent: number;
}

function PrefixGroup({ prefix, items, activePageId, onNavigate, indent }: PrefixGroupProps) {
  const childActive = items.some(
    (n) => n.id === activePageId || hasActiveChild(n, activePageId),
  );
  const [userExpanded, setUserExpanded] = useState(false);
  const expanded = childActive || userExpanded;
  const totalMemories = items.reduce((s, n) => s + (n.memory_count ?? 0), 0);

  return (
    <div>
      <button
        onClick={() => setUserExpanded((v) => !v)}
        className="group/row relative flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        style={{ paddingLeft: `${10 + indent * 14}px` }}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span className="truncate flex-1 font-medium">{prefix}</span>
        {/* Folder counts — overlay on hover, no width reserved when
            hidden so the prefix gets the whole row to truncate against. */}
        <span className="hidden group-hover/row:inline absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground/70 tabular-nums bg-muted/95 backdrop-blur-sm px-1.5 py-0.5 rounded">
          {items.length} pages
          {totalMemories > 0 && ` · ${totalMemories} memories`}
        </span>
      </button>
      {expanded && (
        <div>
          {items.map((node) => {
            // Strip the shared prefix from the displayed title so only
            // the differentiating tail remains; if stripping leaves an
            // empty string, fall back to the full title.
            const stripped = node.title
              .replace(new RegExp(`^${escapeRegExp(prefix)}\\s*`, "i"), "")
              .trim();
            const displayTitle = stripped.length > 0 ? stripped : node.title;
            return (
              <TopicItemWithChildren
                key={node.id}
                node={node}
                activePageId={activePageId}
                onNavigate={onNavigate}
                indent={indent + 1}
                displayTitle={displayTitle}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function WikiSidebar({ pages, activePageId, onNavigate, lang }: WikiSidebarProps) {
  const [topicsExpanded, setTopicsExpanded] = useState(true);
  const topicPages = pages.filter((p) => p.page_type === "topic");
  const fixedPages = pages.filter((p) => p.page_type === "fixed");

  const overviewPage = fixedPages.find((p) => p.id === "overview");
  const afterTopicPages = fixedPages.filter((p) => p.id !== "overview");

  // Compute prefix-groups once per topicPages reference. The grouping
  // is heuristic and stable: same input → same row layout.
  const grouped = useMemo(() => groupByPrefix(topicPages), [topicPages]);

  return (
    <nav className="px-2 pb-4">
      {overviewPage && (
        <SidebarItem
          node={overviewPage}
          isActive={activePageId === overviewPage.id}
          onClick={() => onNavigate(overviewPage.id)}
        />
      )}

      {topicPages.length > 0 && (
        <div className="mt-1">
          <button
            onClick={() => setTopicsExpanded(!topicsExpanded)}
            className="flex items-center gap-1 w-full px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground"
          >
            {topicsExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {wikiT(lang, "topics")}
            <span className="ml-auto text-muted-foreground/70 normal-case font-normal">
              ({topicPages.length})
            </span>
          </button>
          {topicsExpanded &&
            grouped.map((row) => {
              if (row.kind === "group") {
                return (
                  <PrefixGroup
                    key={row.key}
                    prefix={row.prefix}
                    items={row.items}
                    activePageId={activePageId}
                    onNavigate={onNavigate}
                    indent={1}
                  />
                );
              }
              return (
                <TopicItemWithChildren
                  key={row.node.id}
                  node={row.node}
                  activePageId={activePageId}
                  onNavigate={onNavigate}
                  indent={1}
                />
              );
            })}
        </div>
      )}

      {afterTopicPages.map((page) => (
        <SidebarItem
          key={page.id}
          node={page}
          isActive={activePageId === page.id}
          onClick={() => onNavigate(page.id)}
        />
      ))}
    </nav>
  );
}
