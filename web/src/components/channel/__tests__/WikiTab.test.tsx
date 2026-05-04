/**
 * Phase-0 regression test for WikiTab.
 *
 * Bug introduced by c23c955: WikiTab unconditionally read
 *   channelPolicy.effective.wiki.maintenance_mode
 * crashing the entire wiki tab when the policy hadn't loaded yet, or when
 * an older backend returned a policy without the `wiki` sub-tree. Hotfix
 * uses optional-chaining and treats undefined as "manual" (safer fallback,
 * the toolbar's Maintain button stays visible).
 *
 * This test mounts WikiTab with `useChannelPolicy` returning shapes that
 * previously crashed and asserts the component renders without throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// ---------------------------------------------------------------------------
// Hook mocks. Each must be declared BEFORE the component import below so the
// vi.mock() factory replacements are wired into the module graph.
// ---------------------------------------------------------------------------

const mockChannelPolicyState: {
  policy: unknown;
  presets: never[];
  isLoading: boolean;
  error: null;
  savePolicy: ReturnType<typeof vi.fn>;
  deletePolicy: ReturnType<typeof vi.fn>;
  refetch: ReturnType<typeof vi.fn>;
} = {
  policy: null,
  presets: [],
  isLoading: false,
  error: null,
  savePolicy: vi.fn(),
  deletePolicy: vi.fn(),
  refetch: vi.fn(),
};

vi.mock("@/hooks/useChannelPolicy", () => ({
  useChannelPolicy: () => mockChannelPolicyState,
}));

vi.mock("@/hooks/useWiki", () => ({
  useWiki: () => ({
    data: null,
    isLoading: false,
    error: null,
    isNotFound: true,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useChannelMemoryCount", () => ({
  useChannelMemoryCount: () => ({
    hasMemories: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useWikiPage", () => ({
  useWikiPage: () => ({ data: null, isLoading: false, isRevalidating: false }),
}));

vi.mock("@/hooks/useWikiVersions", () => ({
  useWikiVersions: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
}));

vi.mock("@/hooks/useWikiVersion", () => ({
  useWikiVersion: () => ({ data: null, isLoading: false }),
}));

vi.mock("@/hooks/useWikiRefresh", () => ({
  useWikiRefresh: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    generationStatus: null,
  }),
}));

vi.mock("@/hooks/useExtractionStatus", () => ({
  useExtractionStatus: () => ({ status: null }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async () => ({
      supported_languages: ["en"],
      default_target_language: "en",
    })),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  authFetch: vi.fn(),
  API_BASE: "",
}));

// ---------------------------------------------------------------------------
// Component under test (imported AFTER mocks).
// ---------------------------------------------------------------------------

import { WikiTab } from "../WikiTab";

function renderTab() {
  return render(
    <MemoryRouter initialEntries={["/channels/c1/wiki"]}>
      <Routes>
        <Route path="/channels/:id/wiki" element={<WikiTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockChannelPolicyState.policy = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WikiTab — regression: null-safe maintenance_mode resolution", () => {
  it("renders without crashing when channel policy is null (initial load)", async () => {
    mockChannelPolicyState.policy = null;
    expect(() => renderTab()).not.toThrow();
    // Empty-state copy proves the component finished rendering past the
    // manualMode derivation that previously threw.
    await waitFor(() => {
      expect(screen.getByText(/sync this channel first/i)).toBeInTheDocument();
    });
  });

  it("renders without crashing when policy is missing the `wiki` sub-tree", async () => {
    // Simulates an older backend / partial policy response. Pre-fix this
    // crashed: `channelPolicy.effective.wiki.maintenance_mode` → throws on
    // reading `.maintenance_mode` of undefined.
    mockChannelPolicyState.policy = {
      channel_id: "c1",
      preset: null,
      effective: {},
    };
    expect(() => renderTab()).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText(/sync this channel first/i)).toBeInTheDocument();
    });
  });

  it("renders without crashing when policy's `effective.wiki` is undefined", async () => {
    mockChannelPolicyState.policy = {
      channel_id: "c1",
      preset: null,
      effective: { sync: {}, ingestion: {}, consolidation: {} },
    };
    expect(() => renderTab()).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText(/sync this channel first/i)).toBeInTheDocument();
    });
  });
});
