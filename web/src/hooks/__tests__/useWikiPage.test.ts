import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/lib/api", () => {
  class MockApiError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }

  return {
    api: {
      get: vi.fn(),
    },
    ApiError: MockApiError,
  };
});

import { useWikiPage } from "../useWikiPage";
import { api, ApiError } from "@/lib/api";

describe("useWikiPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches by page id when available", async () => {
    const getMock = vi.mocked(api.get);
    getMock.mockResolvedValueOnce({
      id: "topic:work-sentiment",
      content: "# Work Sentiment",
      last_updated: "2026-05-06T13:50:00Z",
    });

    const { result } = renderHook(() =>
      useWikiPage("c1", "topic:work-sentiment"),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith(
      "/api/channels/c1/wiki/pages/topic:work-sentiment",
    );
    expect(result.current.data?.id).toBe("topic:work-sentiment");
  });

  it("falls back to slug lookup when id lookup returns 404", async () => {
    const getMock = vi.mocked(api.get);
    getMock
      .mockRejectedValueOnce(new ApiError(404, "UNKNOWN", "not found"))
      .mockResolvedValueOnce({
        id: "topic:work-sentiment",
        content: "# Work Sentiment",
        last_updated: "2026-05-06T13:50:00Z",
      });

    const { result } = renderHook(() =>
      useWikiPage("c1", "work-sentiment", undefined, "work-sentiment"),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock.mock.calls[0]?.[0]).toBe(
      "/api/channels/c1/wiki/pages/work-sentiment",
    );
    expect(getMock.mock.calls[1]?.[0]).toBe(
      "/api/channels/c1/wiki/pages-by-slug/work-sentiment",
    );
    expect(result.current.data?.id).toBe("topic:work-sentiment");
  });
});
