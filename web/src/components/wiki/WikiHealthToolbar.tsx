import { useState } from "react";
import { AlertTriangle, ClipboardCheck, Loader2, Sparkles, X } from "lucide-react";
import { useWikiLint } from "@/hooks/useWikiLint";
import { useWikiMaintain } from "@/hooks/useWikiMaintain";

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

  const findingsCount = lint.report?.findings.length ?? 0;
  const errorCount = lint.report?.findings.filter((f) => f.severity === "error").length ?? 0;
  const warnCount = lint.report?.findings.filter((f) => f.severity === "warning").length ?? 0;

  return (
    <div className="flex items-center gap-2">
      {manualMode && (
        <button
          onClick={() => maintain.maintain()}
          disabled={maintain.loading || !channelId}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border/60 bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Re-run the maintainer on pages flagged dirty since the last run"
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
        </button>
      )}

      <button
        onClick={async () => {
          await lint.runLint();
          setReportOpen(true);
        }}
        disabled={lint.loading || !channelId}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border/60 bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title="Scan the wiki for orphan / stale / duplicate / coherence issues"
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
      </button>

      {/* Lint findings panel — slides in below the toolbar when populated */}
      {reportOpen && lint.report && (
        <div className="fixed right-4 top-20 z-30 w-96 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-background shadow-lg p-3">
          <header className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">
              Lint findings
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                ({findingsCount} across {lint.report.pages_scanned} pages)
              </span>
            </h3>
            <button
              onClick={() => setReportOpen(false)}
              className="p-0.5 rounded hover:bg-muted"
              aria-label="Close findings"
            >
              <X size={14} />
            </button>
          </header>
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

      {lint.error && (
        <span className="text-xs text-red-600 dark:text-red-400">Lint failed</span>
      )}
      {maintain.error && (
        <span className="text-xs text-red-600 dark:text-red-400">Maintain failed</span>
      )}
    </div>
  );
}
