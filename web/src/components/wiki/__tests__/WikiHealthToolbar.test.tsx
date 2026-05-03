import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WikiHealthToolbar } from "../WikiHealthToolbar";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock useWikiLint
const mockRunLint = vi.fn();
const mockLintClear = vi.fn();
const mockLintState = {
  report: null as null | { findings: { severity: string; page_id: string; section_id?: string; message: string; suggested_action?: string; category: string }[]; pages_scanned: number; channel_id: string; target_lang: string; generated_at: string },
  loading: false,
  error: null as string | null,
  runLint: mockRunLint,
  clear: mockLintClear,
};

vi.mock("@/hooks/useWikiLint", () => ({
  useWikiLint: () => mockLintState,
}));

// Mock useWikiMaintain
const mockMaintain = vi.fn();
const mockMaintainState = {
  result: null as null | { rewritten: number; errors: number },
  loading: false,
  error: null as string | null,
  maintain: mockMaintain,
};

vi.mock("@/hooks/useWikiMaintain", () => ({
  useWikiMaintain: () => mockMaintainState,
}));

// Mock FailedBatchPanel to avoid fetch in tests
vi.mock("../FailedBatchPanel", () => ({
  FailedBatchPanel: ({ onClose }: { channelId: string; onClose?: () => void }) => (
    <div data-testid="failed-batch-panel">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// Tooltip provider is not needed since TooltipTrigger renders children directly
// Mock the tooltip components for simplicity
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  // TooltipTrigger forwards all props to a <button> so tests can find it by role/label
  TooltipTrigger: ({
    children,
    className,
    onClick,
    disabled,
    "aria-label": ariaLabel,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      className={className}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content" hidden>{children}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderToolbar(
  props: Partial<{
    manualMode: boolean;
    versionCount: number;
    failureCount: number;
    onDownload: () => void;
    onHistoryToggle: () => void;
    onRegenerate: () => void;
    isRegenerating: boolean;
  }> = {},
) {
  return render(
    <WikiHealthToolbar
      channelId="ch-1"
      manualMode={props.manualMode ?? true}
      versionCount={props.versionCount ?? 0}
      failureCount={props.failureCount}
      onDownload={props.onDownload}
      onHistoryToggle={props.onHistoryToggle}
      onRegenerate={props.onRegenerate}
      isRegenerating={props.isRegenerating ?? false}
    />,
  );
}

beforeEach(() => {
  mockLintState.report = null;
  mockLintState.loading = false;
  mockLintState.error = null;
  mockMaintainState.result = null;
  mockMaintainState.loading = false;
  mockMaintainState.error = null;
  mockRunLint.mockResolvedValue(undefined);
  mockMaintain.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Issue 1 — manualMode regression tests
// ---------------------------------------------------------------------------

describe("WikiHealthToolbar — manualMode", () => {
  it("shows Maintain Wiki button when manualMode=true", () => {
    renderToolbar({ manualMode: true });
    expect(screen.getByRole("button", { name: /maintain wiki/i })).toBeInTheDocument();
  });

  it("hides Maintain Wiki button when manualMode=false", () => {
    renderToolbar({ manualMode: false });
    expect(screen.queryByRole("button", { name: /maintain wiki/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Issue 2 — Tools menu
// ---------------------------------------------------------------------------

describe("WikiHealthToolbar — Tools menu", () => {
  it("renders Tools button always", () => {
    renderToolbar();
    expect(screen.getByRole("button", { name: /wiki tools menu/i })).toBeInTheDocument();
  });

  it("Tools menu is closed by default", () => {
    renderToolbar();
    expect(screen.queryByRole("menu", { name: /wiki tools/i })).not.toBeInTheDocument();
  });

  it("opens menu when Tools button is clicked", async () => {
    renderToolbar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    expect(screen.getByRole("menu", { name: /wiki tools/i })).toBeInTheDocument();
  });

  it("menu contains Lint Wiki, History, Download items", async () => {
    renderToolbar({ versionCount: 3 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    expect(screen.getByRole("menuitem", { name: /lint wiki/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /download/i })).toBeInTheDocument();
  });

  it("Failures item is visible when failureCount > 0", async () => {
    renderToolbar({ failureCount: 3 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    expect(screen.getByRole("menuitem", { name: /view failed extractions/i })).toBeInTheDocument();
  });

  it("Failures item is hidden when failureCount is 0", async () => {
    renderToolbar({ failureCount: 0 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    expect(screen.queryByRole("menuitem", { name: /view failed extractions/i })).not.toBeInTheDocument();
  });

  it("Failures item is visible when failureCount is undefined (unknown)", async () => {
    // When count is unknown we show the item (defensive)
    renderToolbar({ failureCount: undefined });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    expect(screen.getByRole("menuitem", { name: /view failed extractions/i })).toBeInTheDocument();
  });

  it("Regenerate from scratch item is shown when onRegenerate is provided", async () => {
    renderToolbar({ onRegenerate: vi.fn() });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    expect(screen.getByRole("menuitem", { name: /regenerate wiki from scratch/i })).toBeInTheDocument();
  });

  it("Regenerate shows confirm dialog before firing", async () => {
    const onRegenerate = vi.fn();
    renderToolbar({ onRegenerate });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /regenerate wiki from scratch/i }));
    // Confirm prompt appears — not yet called
    expect(screen.getByRole("button", { name: /confirm regenerate/i })).toBeInTheDocument();
    expect(onRegenerate).not.toHaveBeenCalled();
    // Confirm fires the callback
    await user.click(screen.getByRole("button", { name: /confirm regenerate/i }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("Cancel on regenerate confirm hides the confirm prompt", async () => {
    renderToolbar({ onRegenerate: vi.fn() });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /regenerate wiki from scratch/i }));
    await user.click(screen.getByRole("button", { name: /cancel regenerate/i }));
    expect(screen.queryByRole("button", { name: /confirm regenerate/i })).not.toBeInTheDocument();
  });

  it("Lint Wiki click runs lint and opens findings panel", async () => {
    mockRunLint.mockImplementation(() => {
      mockLintState.report = {
        findings: [],
        pages_scanned: 3,
        channel_id: "ch-1",
        target_lang: "en",
        generated_at: new Date().toISOString(),
      };
      return Promise.resolve();
    });

    renderToolbar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /lint wiki/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /lint findings/i })).toBeInTheDocument();
    });
  });

  it("Download calls onDownload", async () => {
    const onDownload = vi.fn();
    renderToolbar({ onDownload });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /download wiki/i }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("History calls onHistoryToggle", async () => {
    const onHistoryToggle = vi.fn();
    renderToolbar({ onHistoryToggle, versionCount: 2 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /version history/i }));
    expect(onHistoryToggle).toHaveBeenCalledTimes(1);
  });

  it("Failures click opens FailedBatchPanel", async () => {
    renderToolbar({ failureCount: 5 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /view failed extractions/i }));
    await waitFor(() => {
      expect(screen.getByTestId("failed-batch-panel")).toBeInTheDocument();
    });
  });

  it("menu closes on Escape", async () => {
    renderToolbar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Legacy tests — carried over / migrated
// ---------------------------------------------------------------------------

describe("WikiHealthToolbar — Maintain Wiki", () => {
  it("has aria-label on Maintain Wiki button", () => {
    renderToolbar({ manualMode: true });
    const btn = screen.getByRole("button", { name: /maintain wiki/i });
    expect(btn).toHaveAttribute("aria-label");
  });

  it("shows loading state while maintaining", () => {
    mockMaintainState.loading = true;
    renderToolbar({ manualMode: true });
    expect(screen.getByRole("button", { name: /maintain wiki/i })).toBeDisabled();
  });

  it("shows maintain error with retry button", () => {
    mockMaintainState.error = "Maintain failed";
    renderToolbar({ manualMode: true });
    expect(screen.getByText("Maintain failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry maintain/i })).toBeInTheDocument();
  });
});

describe("WikiHealthToolbar — Lint findings panel", () => {
  it("shows loading skeleton during lint scan with role=status and aria-live", async () => {
    mockLintState.loading = false;
    mockLintState.report = {
      findings: [],
      pages_scanned: 4,
      channel_id: "ch-1",
      target_lang: "en",
      generated_at: new Date().toISOString(),
    };

    const { rerender } = renderToolbar();
    const user = userEvent.setup();

    // Open the Tools menu and click Lint Wiki
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /lint wiki/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Now simulate lint running again — flip loading=true
    mockLintState.loading = true;
    rerender(
      <WikiHealthToolbar channelId="ch-1" manualMode={true} />,
    );

    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("shows retry button on lint error", async () => {
    mockLintState.error = "Network error";
    mockLintState.loading = false;

    renderToolbar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /lint wiki/i }));

    expect(screen.getByRole("button", { name: /retry lint/i })).toBeInTheDocument();
  });

  it("retry button calls runLint again", async () => {
    mockLintState.error = "Network error";
    mockLintState.loading = false;

    renderToolbar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /lint wiki/i }));
    await user.click(screen.getByRole("button", { name: /retry lint/i }));

    // runLint called once by the menu click, once by retry
    expect(mockRunLint).toHaveBeenCalledTimes(2);
  });

  it("opens findings panel with role=dialog after lint completes", async () => {
    mockRunLint.mockImplementation(() => {
      mockLintState.report = {
        findings: [],
        pages_scanned: 3,
        channel_id: "ch-1",
        target_lang: "en",
        generated_at: new Date().toISOString(),
      };
      return Promise.resolve();
    });

    renderToolbar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /lint wiki/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Lint findings");
  });

  it("shows no-issues message when findings is empty", async () => {
    mockLintState.report = {
      findings: [],
      pages_scanned: 2,
      channel_id: "ch-1",
      target_lang: "en",
      generated_at: new Date().toISOString(),
    };

    renderToolbar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /wiki tools menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /lint wiki/i }));

    await waitFor(() => {
      expect(screen.getByText(/no issues/i)).toBeInTheDocument();
    });
  });
});
