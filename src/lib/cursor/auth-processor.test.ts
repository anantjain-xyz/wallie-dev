import { afterEach, describe, expect, it, vi } from "vitest";

import { completeCursorAuthFlow, startCursorAuthProcessor } from "@/lib/cursor/auth-processor";

afterEach(() => {
  vi.useRealTimers();
});

describe("startCursorAuthProcessor", () => {
  it("processes sign-in flows concurrently up to a bounded limit", async () => {
    vi.useFakeTimers();
    const processFlow = vi.fn(
      (_admin: unknown, _workerId: string, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener("abort", () => resolve(true), { once: true });
        }),
    );
    const processor = startCursorAuthProcessor({} as never, "worker-1", {
      concurrencyLimit: 2,
      pollIntervalMs: 100,
      processFlow,
    });

    expect(processFlow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(processFlow).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(processFlow).toHaveBeenCalledTimes(2);

    await processor.stop();
    expect(processFlow.mock.calls.every((call) => call[2]?.aborted)).toBe(true);
  });
});

describe("completeCursorAuthFlow", () => {
  it("delegates credential publication and flow completion to one guarded RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
    const completed = await completeCursorAuthFlow({ rpc } as never, {
      accountEmail: "person@example.com",
      apiKeyExpiresAt: "2099-01-01T00:00:00.000Z",
      completedAt: "2026-08-29T22:00:00.000Z",
      encryptedApiKey: "encrypted-key",
      flowId: "00000000-0000-4000-8000-000000000001",
    });

    expect(completed).toBe(false);
    expect(rpc).toHaveBeenCalledWith("complete_cursor_auth_flow", {
      p_account_email: "person@example.com",
      p_api_key_expires_at: "2099-01-01T00:00:00.000Z",
      p_completed_at: "2026-08-29T22:00:00.000Z",
      p_encrypted_api_key: "encrypted-key",
      p_flow_id: "00000000-0000-4000-8000-000000000001",
    });
  });
});
