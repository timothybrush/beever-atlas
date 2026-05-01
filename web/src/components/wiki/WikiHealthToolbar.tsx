import { useEffect, useState } from "react";
import { AlertTriangle, ClipboardCheck, Loader2, RefreshCw, Sparkles, X, ListX } from "lucide-react";
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
}

const SEVERITY_STYLES = {
  error: "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300",
  warning: "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300",
  info: "border-sky-200 dark:border-sky-900/50 bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300",
} as const;

/**
 * Wiki health toolbar — lint + maintain actions surfaced in the wiki header.
 *
 * Two operator-facing buttons:
 *   - "Lint Wiki": runs orphan / stale / duplicate / coherence checks and
 *     renders findings sorted by severity in a collapsible panel.
 *   - "Maintain Wiki" (manual mode only): asks the maintainer to rewrite
 *     pages flagged dirty since the last maintenance run. Hidden when
 *     auto mode is on.
 *
 * Intended to be passed as the `headerExtra` slot on `WikiLayout`.
 */
export function WikiHealthToolbar({ channelId, manualMode = true }: Props) {
  const lint = useWikiLint(channelId);
  const maintain = useWikiMaintain(channelId);
  const [reportOpen, setReportOpen] = useState(false);
  const [failuresOpen, setFailuresOpen] = useState(false);

  // Close any open panel on Escape so keyboard users can dismiss them
  // without mouse focus on the close button. Both panels carry
  // ``aria-modal="true"`` (set on the dialog elements below) so screen
  // readers announce them correctly.
  useEffect(() => {
    if (!reportOpen && !failuresOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setReportOpen(false);
        setFailuresOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reportOpen, failuresOpen]);

  const findingsCount = lint.report?.findings.length ?? 0;
  const errorCount = lint.report?.findings.filter((f) => f.severity === "error").length ?? 0;
  const warnCount = lint.report?.findings.filter((f) => f.severity === "warning").length ?? 0;

  return (
    <div className="flex items-center gap-2">
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

      <Tooltip>
        <TooltipTrigger
          aria-label="Lint Wiki — scan for orphan, stale, duplicate, and coherence issues"
          onClick={async () => {
            await lint.runLint();
            setReportOpen(true);
          }}
          disabled={lint.loading || !channelId}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border/60 bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {lint.loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <ClipboardCheck size={12} />
          )}
          {lint.loading ? "Linting..." : "Lint Wiki"}
          {findingsCount > 0 && (
            <span className="ml-0.5 text-muted-foreground">
              ({errorCount + warnCount > 0 ? `${errorCount + warnCount}!` : findingsCount})
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>
          Scan the wiki for orphan, stale, duplicate, and coherence issues. See{" "}
          <a href="/docs/integrations/openclaw.md" className="underline" target="_blank" rel="noreferrer">
            integration cookbook
          </a>{" "}
          for details.
        </TooltipContent>
      </Tooltip>

      <button
        aria-label="View failed extractions"
        onClick={() => {
          // Mutually exclusive — opening failures closes the lint panel
          // so the two side panels never stack on top of each other.
          setReportOpen(false);
          setFailuresOpen((v) => !v);
        }}
        disabled={!channelId}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border/60 bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <ListX size={12} />
        Failures
      </button>

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

          {/* View failures button inside findings panel */}
          {channelId && (
            <div className="px-4 py-3 border-t border-border shrink-0">
              <button
                type="button"
                onClick={() => {
                  setReportOpen(false);
                  setFailuresOpen(true);
                }}
                aria-label="Switch to failed extractions panel"
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-md border border-border hover:bg-muted transition-colors"
              >
                <ListX size={12} />
                View failed extractions
              </button>
            </div>
          )}
        </div>
      )}

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
