import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Stub the admin token before any component import so the hook reads it.
vi.stubEnv("VITE_BEEVER_ADMIN_TOKEN", "test-admin-token");

// ---------------------------------------------------------------------------
// Component under test (inner form accepts pre-fetched data — no fetch needed)
// ---------------------------------------------------------------------------
import { ExtractionWorkerPanelInner } from "../ExtractionWorkerPanel";
import type { ExtractionStatusResponse } from "@/hooks/useExtractionStatus";
import type {
  ExtractionWorkerMetrics,
  WikiMaintainerMetrics,
} from "@/hooks/useExtractionWorkerMetrics";

// ---------------------------------------------------------------------------
// For testing the public component (which owns polling) we need to stub fetch
// ---------------------------------------------------------------------------
import { ExtractionWorkerPanel } from "../ExtractionWorkerPanel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeExtractionStatus(
  overrides: Partial<ExtractionStatusResponse["counts"]> = {},
): ExtractionStatusResponse {
  return {
    channel_id: "C1",
    counts: {
      pending: 50,
      extracting: 20,
      done: 430,
      failed: 0,
      ...overrides,
    },
    total: 500,
  };
}

const WORKER_METRICS_HEALTHY: ExtractionWorkerMetrics = {
  queue_depth_per_channel: { C1: 70 },
  claim_rate_5min: 0.8,
  claim_rate_15min: 0.75,
  claim_rate_60min: 0.7,
  success_rate_5min: 1.0,
  breaker_state: "closed",
  recent_failures: [],
};

const WORKER_METRICS_OPEN: ExtractionWorkerMetrics = {
  ...WORKER_METRICS_HEALTHY,
  breaker_state: "open",
  success_rate_5min: 0.4,
  recent_failures: [
    { message_id: "m1", channel_id: "C1", error_class: "TimeoutError" },
    { message_id: "m2", channel_id: "C1", error_class: "RateLimitError" },
  ],
};

const WIKI_METRICS_ACTIVE: WikiMaintainerMetrics = {
  apply_update_count_5min: 42,
  mark_dirty_count_5min: 5,
  rewrite_count_by_page_kind: { summary: 3, people: 1 },
  pending_dirty_pages_per_channel: { C1: 2 },
  apply_update_failures: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExtractionWorkerPanelInner — count chips", () => {
  it("renders all four counts from extraction status", () => {
    const status = makeExtractionStatus({ pending: 50, extracting: 20, done: 430, failed: 2 });
    render(
      <ExtractionWorkerPanelInner
        extractionStatus={status}
        workerMetrics={WORKER_METRICS_HEALTHY}
        wikiMetrics={null}
      />,
    );

    expect(screen.getByTestId("chip-done")).toHaveTextContent("430");
    expect(screen.getByTestId("chip-extracting")).toHaveTextContent("20");
    expect(screen.getByTestId("chip-pending")).toHaveTextContent("50");
    expect(screen.getByTestId("chip-failed")).toHaveTextContent("2");
  });

  it("renders a stacked progress bar with aria attributes", () => {
    const status = makeExtractionStatus({ done: 430, extracting: 20, pending: 50, failed: 0 });
    render(
      <ExtractionWorkerPanelInner
        extractionStatus={status}
        workerMetrics={null}
        wikiMetrics={null}
      />,
    );

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "430");
    expect(bar).toHaveAttribute("aria-valuemax", "500");
  });
});

describe("ExtractionWorkerPanelInner — breaker badge", () => {
  it("shows a healthy (closed) badge when breaker_state is closed", () => {
    render(
      <ExtractionWorkerPanelInner
        extractionStatus={makeExtractionStatus()}
        workerMetrics={WORKER_METRICS_HEALTHY}
        wikiMetrics={null}
      />,
    );

    const badge = screen.getByTestId("breaker-badge");
    expect(badge).toHaveTextContent(/healthy/i);
  });

  it("shows an open badge when breaker_state is open", () => {
    render(
      <ExtractionWorkerPanelInner
        extractionStatus={makeExtractionStatus()}
        workerMetrics={WORKER_METRICS_OPEN}
        wikiMetrics={null}
      />,
    );

    const badge = screen.getByTestId("breaker-badge");
    expect(badge).toHaveTextContent(/open/i);
  });

  it("shows no breaker badge when workerMetrics is null", () => {
    render(
      <ExtractionWorkerPanelInner
        extractionStatus={makeExtractionStatus()}
        workerMetrics={null}
        wikiMetrics={null}
      />,
    );

    expect(screen.queryByTestId("breaker-badge")).not.toBeInTheDocument();
  });
});

describe("ExtractionWorkerPanelInner — wiki activity", () => {
  it("shows wiki facts and rewrites when wiki metrics are non-zero", () => {
    render(
      <ExtractionWorkerPanelInner
        extractionStatus={makeExtractionStatus()}
        workerMetrics={WORKER_METRICS_HEALTHY}
        wikiMetrics={WIKI_METRICS_ACTIVE}
      />,
    );

    // apply_update_count_5min=42 → "42 facts integrated into wiki"
    // rewrite_count_by_page_kind sums to 4 → "4 pages refreshed"
    // Numbers and labels are split across child <span> nodes; query the
    // containing panel and check its full textContent.
    const panel = screen.getByTestId("extraction-worker-panel");
    expect(panel).toHaveTextContent("42");
    expect(panel).toHaveTextContent(/facts integrated into wiki/i);
    expect(panel).toHaveTextContent(/pages refreshed/i);
  });

  it("does not render wiki row when wiki metrics are zero", () => {
    render(
      <ExtractionWorkerPanelInner
        extractionStatus={makeExtractionStatus()}
        workerMetrics={WORKER_METRICS_HEALTHY}
        wikiMetrics={{
          apply_update_count_5min: 0,
          mark_dirty_count_5min: 0,
          rewrite_count_by_page_kind: {},
          pending_dirty_pages_per_channel: {},
          apply_update_failures: 0,
        }}
      />,
    );

    expect(screen.queryByText(/facts integrated/i)).not.toBeInTheDocument();
  });
});

describe("ExtractionWorkerPanel (public) — hides legacy widget in decoupled mode", () => {
  it("renders the panel and polls metrics when extraction is active", async () => {
    // Use selective fake timers — avoid faking setTimeout/clearTimeout which
    // deadlocks waitFor. Only fake setInterval/clearInterval for the polling loop.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        makeFetchResponse({
          queue_depth_per_channel: {},
          claim_rate_5min: 0.5,
          claim_rate_15min: 0.4,
          claim_rate_60min: 0.3,
          success_rate_5min: 1.0,
          breaker_state: "closed",
          recent_failures: [],
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          apply_update_count_5min: 0,
          mark_dirty_count_5min: 0,
          rewrite_count_by_page_kind: {},
          pending_dirty_pages_per_channel: {},
          apply_update_failures: 0,
        }),
      );

    const status = makeExtractionStatus({ pending: 100, extracting: 10, done: 390, failed: 0 });

    render(<ExtractionWorkerPanel channelId="C1" extractionStatus={status} />);

    await waitFor(() => {
      expect(screen.getByTestId("extraction-worker-panel")).toBeInTheDocument();
    });

    // Chip counts are visible
    expect(screen.getByTestId("chip-done")).toHaveTextContent("390");
    expect(screen.getByTestId("chip-pending")).toHaveTextContent("100");
  });

  it("returns null when extractionStatus is null (nothing to show)", () => {
    const { container } = render(
      <ExtractionWorkerPanel channelId="C1" extractionStatus={null} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
