import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ClipboardCheck,
  Download,
  History,
  Loader2,
  RefreshCw,
  Sparkles,
  Wrench,
  X,
  ListX,
} from "lucide-react";
import { useWikiLint } from "@/hooks/useWikiLint";
import { useWikiMaintain } from "@/hooks/useWikiMaintain";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { FailedBatchPanel } from "@/components/wiki/FailedBatchPanel";

interface Props {
  channelId: string;
  /**
   * When true, the maintainer is in manual mode and the user is responsible
   * for clicking "Maintain Wiki" to drain dirty pages. When false, the
   * maintainer auto-fires and the button is hidden.
   */
  manualMode?: boolean;
  /** Called when the user clicks "Download" from the Tools menu. */
  onDownload?: () => void;
  /** Called when the user clicks "History" from the Tools menu. */
  onHistoryToggle?: () => void;
  /** Whether the version history panel is currently open. */
  historyOpen?: boolean;
  /** Number of stored versions — shown as a badge on the History item. */
  versionCount?: number;
  /** Called when the user clicks "Regenerate from scratch" from the Tools menu. */
  onRegenerate?: () => void;
  /** Whether a regeneration is currently running. */
  isRegenerating?: boolean;
  /** Number of failed extractions — Failures item is hidden when 0. */
  failureCount?: number;
}

const SEVERITY_STYLES = {
  error: "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300",
  warning: "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300",
  info: "border-sky-200 dark:border-sky-900/50 bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300",
} as const;

const TOOL_BTN =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-muted text-foreground";

/**
 * Wiki health toolbar — primary action + collapsible Tools menu.
 *
 * Layout:
 *   [Maintain Wiki (N)]  — only when manualMode is true
 *   [Tools ▾]            — always; opens a dropdown with:
 *       🩹 Lint Wiki
 *       🕘 History
 *       📥 Download
 *       ─────────────
 *       🔧 Failures (N)  — only when failureCount > 0
 *       🔄 Regenerate from scratch  — danger, shows confirm modal
 */
export function WikiHealthToolbar({
  channelId,
  manualMode = true,
  onDownload,
  onHistoryToggle,
  historyOpen = false,
  versionCount = 0,
  onRegenerate,
  isRegenerating = false,
  failureCount,
}: Props) {
  const lint = useWikiLint(channelId);
  const maintain = useWikiMaintain(channelId);
  const [reportOpen, setReportOpen] = useState(false);
  const [failuresOpen, setFailuresOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);

  // Close everything on Escape
  useEffect(() => {
    if (!reportOpen && !failuresOpen && !toolsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setReportOpen(false);
        setFailuresOpen(false);
        setToolsOpen(false);
        setConfirmRegenerate(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reportOpen, failuresOpen, toolsOpen]);

  // Close Tools menu on outside click
  useEffect(() => {
    if (!toolsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) {
        setToolsOpen(false);
        setConfirmRegenerate(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [toolsOpen]);

  const findingsCount = lint.report?.findings.length ?? 0;
  const errorCount = lint.report?.findings.filter((f) => f.severity === "error").length ?? 0;
  const warnCount = lint.report?.findings.filter((f) => f.severity === "warning").length ?? 0;
  const lintBadge = findingsCount > 0 ? (errorCount + warnCount > 0 ? `${errorCount + warnCount}!` : findingsCount) : null;

  const showFailuresItem = failureCount === undefined ? true : failureCount > 0;

  return (
    <div className="flex items-center gap-2">
      {/* Primary CTA: Maintain Wiki — only in manual mode */}
      {manualMode && (
        <Tooltip>
          <TooltipTrigger
            aria-label="Maintain Wiki — re-run the maintainer on pages flagged dirty since the last run"
            onClick={() => maintain.maintain()}
            disabled={maintain.loading || !channelId}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border/60 bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {maintain.loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            {maintain.loading ? "Maintaining..." : "Maintain Wiki"}
            {maintain.result && maintain.result.rewritten > 0 && (
              <span className="text-muted-foreground">({maintain.result.rewritten})</span>
            )}
          </TooltipTrigger>
          <TooltipContent>
            Re-run the WikiMaintainer on all dirty pages. See{" "}
            <a href="/docs/integrations/openclaw.md" className="underline" target="_blank" rel="noreferrer">
              integration cookbook
            </a>{" "}
            for details.
          </TooltipContent>
        </Tooltip>
      )}

      {/* Tools dropdown */}
      <div ref={toolsRef} className="relative">
        <button
          type="button"
          aria-label="Wiki tools menu"
          aria-haspopup="true"
          aria-expanded={toolsOpen}
          onClick={() => {
            setToolsOpen((v) => !v);
            setConfirmRegenerate(false);
          }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border/60 bg-background hover:bg-muted transition-colors"
        >
          <Wrench size={12} />
          Tools
          <ChevronDown
            size={11}
            className={`transition-transform ${toolsOpen ? "rotate-180" : ""}`}
          />
        </button>

        {toolsOpen && (
          <div
            role="menu"
            aria-label="Wiki tools"
            className="absolute right-0 top-full mt-1.5 z-50 w-52 rounded-xl border border-border bg-popover p-1 shadow-xl"
          >
            {/* Lint Wiki */}
            <button
              role="menuitem"
              type="button"
              onClick={async () => {
                setToolsOpen(false);
                await lint.runLint();
                setReportOpen(true);
              }}
              disabled={lint.loading || !channelId}
              className={TOOL_BTN + " disabled:opacity-50 disabled:cursor-not-allowed"}
              aria-label="Lint Wiki — scan for orphan, stale, duplicate, and coherence issues"
            >
              {lint.loading ? (
                <Loader2 size={12} className="animate-spin shrink-0" />
              ) : (
                <ClipboardCheck size={12} className="shrink-0" />
              )}
              <span className="flex-1">{lint.loading ? "Linting…" : "Lint Wiki"}</span>
              {lintBadge !== null && (
                <span className="rounded-full bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  {lintBadge}
                </span>
              )}
            </button>

            {/* History */}
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setToolsOpen(false);
                onHistoryToggle?.();
              }}
              disabled={versionCount === 0}
              className={TOOL_BTN + ` disabled:opacity-40 disabled:cursor-not-allowed ${historyOpen ? "bg-primary/10 text-primary hover:bg-primary/15" : ""}`}
              aria-label={`Version history${versionCount > 0 ? ` — ${versionCount} versions` : ""}`}
            >
              <History size={12} className="shrink-0" />
              <span className="flex-1">History</span>
              {versionCount > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                  {versionCount}
                </span>
              )}
            </button>

            {/* Download */}
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setToolsOpen(false);
                onDownload?.();
              }}
              disabled={!channelId}
              className={TOOL_BTN + " disabled:opacity-40 disabled:cursor-not-allowed"}
              aria-label="Download wiki as Markdown"
            >
              <Download size={12} className="shrink-0" />
              <span className="flex-1">Download</span>
            </button>

            {/* Divider — only when Failures or Regenerate is shown */}
            {(showFailuresItem || onRegenerate) && (
              <div className="my-1 h-px bg-border/60" />
            )}

            {/* Failures — hidden when count is 0 */}
            {showFailuresItem && (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setToolsOpen(false);
                  setReportOpen(false);
                  setFailuresOpen((v) => !v);
                }}
                disabled={!channelId}
                className={TOOL_BTN + " disabled:opacity-40 disabled:cursor-not-allowed"}
                aria-label="View failed extractions"
              >
                <ListX size={12} className="shrink-0" />
                <span className="flex-1">Failures</span>
                {failureCount !== undefined && failureCount > 0 && (
                  <span className="rounded-full bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300 tabular-nums">
                    {failureCount}
                  </span>
                )}
              </button>
            )}

            {/* Regenerate from scratch — danger */}
            {onRegenerate && (
              confirmRegenerate ? (
                <div className="mt-1 rounded-md border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-2">
                  <p className="mb-2 text-[11px] text-red-700 dark:text-red-300 leading-snug">
                    This will overwrite the current wiki. Continue?
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmRegenerate(false);
                        setToolsOpen(false);
                        onRegenerate();
                      }}
                      className="flex-1 rounded px-2 py-1 text-[11px] font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
                      aria-label="Confirm regenerate wiki from scratch"
                    >
                      Regenerate
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRegenerate(false)}
                      className="rounded px-2 py-1 text-[11px] font-medium border border-border hover:bg-muted transition-colors"
                      aria-label="Cancel regenerate"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => setConfirmRegenerate(true)}
                  disabled={isRegenerating}
                  className={TOOL_BTN + " text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 disabled:opacity-40 disabled:cursor-not-allowed"}
                  aria-label="Regenerate wiki from scratch"
                >
                  {isRegenerating ? (
                    <Loader2 size={12} className="animate-spin shrink-0" />
                  ) : (
                    <RefreshCw size={12} className="shrink-0" />
                  )}
                  <span className="flex-1">Regenerate from scratch</span>
                </button>
              )
            )}
          </div>
        )}
      </div>

      {/* Maintain error retry */}
      {maintain.error && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-red-600 dark:text-red-400">Maintain failed</span>
          <button
            type="button"
            onClick={() => maintain.maintain()}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border border-border hover:bg-muted transition-colors"
            aria-label="Retry maintain"
          >
            <RefreshCw size={10} />
            Retry
          </button>
        </div>
      )}

      {/* Lint findings panel — Sheet-style, slides from right */}
      {reportOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Lint findings"
          className="fixed right-0 top-0 z-40 h-full w-full max-w-sm md:w-96 bg-background border-l border-border shadow-2xl flex flex-col"
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <h3 className="text-sm font-semibold">
              Lint findings
              {lint.report && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  ({findingsCount} across {lint.report.pages_scanned} pages)
                </span>
              )}
            </h3>
            <button
              onClick={() => setReportOpen(false)}
              className="p-0.5 rounded hover:bg-muted transition-colors"
              aria-label="Close findings"
            >
              <X size={14} />
            </button>
          </header>

          {/* Loading skeleton during lint scan */}
          {lint.loading && (
            <div
              role="status"
              aria-live="polite"
              className="flex-1 px-4 py-4 space-y-2"
            >
              <p className="text-xs text-muted-foreground mb-3">
                Scanning {lint.report?.pages_scanned ?? "…"} pages…
              </p>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          )}

          {!lint.loading && lint.error && (
            <div className="flex-1 px-4 py-6 space-y-3">
              <p className="text-sm text-rose-600 dark:text-rose-400">Lint failed: {lint.error}</p>
              <button
                type="button"
                onClick={async () => {
                  await lint.runLint();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted transition-colors"
                aria-label="Retry lint"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          )}

          {!lint.loading && !lint.error && lint.report && (
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {findingsCount === 0 ? (
                <p className="text-xs text-muted-foreground py-3">
                  No issues — wiki is healthy.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {lint.report.findings.map((f, i) => (
                    <li
                      key={`${f.page_id}-${f.section_id || ""}-${i}`}
                      className={`rounded border px-2 py-1.5 text-[11px] ${SEVERITY_STYLES[f.severity]}`}
                    >
                      <div className="flex items-start gap-1.5">
                        {f.severity === "error" || f.severity === "warning" ? (
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                        ) : null}
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {f.page_id}
                            {f.section_id && (
                              <span className="text-muted-foreground/70"> · {f.section_id}</span>
                            )}
                          </p>
                          <p className="leading-snug">{f.message}</p>
                          {f.suggested_action && (
                            <p className="mt-0.5 text-muted-foreground italic">
                              {f.suggested_action}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Failed extractions panel */}
      {failuresOpen && channelId && (
        <FailedBatchPanel
          channelId={channelId}
          onClose={() => setFailuresOpen(false)}
        />
      )}
    </div>
  );
}
