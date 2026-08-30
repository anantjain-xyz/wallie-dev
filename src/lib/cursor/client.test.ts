import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverCursorModels } from "@/lib/cursor/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoverCursorModels", () => {
  it("refreshes connection state when model discovery rejects the credential", async () => {
    const reconnectStatus = {
      checkedAt: "2026-08-29T22:00:00.000Z",
      connected: false,
      reconnectReason: "Reconnect Cursor.",
      reconnectRequired: true,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ error: "Cursor rejected the saved credential." }),
        ok: false,
      })
      .mockResolvedValueOnce({ json: async () => reconnectStatus, ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverCursorModels()).resolves.toEqual({
      connectionStatus: reconnectStatus,
      models: [],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/cursor/models",
      "/api/cursor/connection",
    ]);
  });
});
