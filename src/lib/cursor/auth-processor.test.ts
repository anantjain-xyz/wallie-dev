import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_AUTH_FLOW_LEASE_MS,
  completeCursorAuthFlow,
  createCursorAuthClaimToken,
  publishCursorLoginUrl,
  reclaimStaleCursorAuthFlows,
  startCursorAuthProcessor,
} from "@/lib/cursor/auth-processor";

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
      claimedBy: "worker-1",
      completedAt: "2026-08-29T22:00:00.000Z",
      encryptedApiKey: "encrypted-key",
      flowId: "00000000-0000-4000-8000-000000000001",
    });

    expect(completed).toBe(false);
    expect(rpc).toHaveBeenCalledWith("complete_cursor_auth_flow", {
      p_account_email: "person@example.com",
      p_api_key_expires_at: "2099-01-01T00:00:00.000Z",
      p_claimed_by: "worker-1",
      p_completed_at: "2026-08-29T22:00:00.000Z",
      p_encrypted_api_key: "encrypted-key",
      p_flow_id: "00000000-0000-4000-8000-000000000001",
    });
  });
});

describe("createCursorAuthClaimToken", () => {
  it("mints a unique token for every claim made by the same worker", () => {
    const first = createCursorAuthClaimToken("worker-1");
    const second = createCursorAuthClaimToken("worker-1");

    expect(first).toMatch(/^worker-1:/);
    expect(second).toMatch(/^worker-1:/);
    expect(second).not.toBe(first);
  });
});

describe("publishCursorLoginUrl", () => {
  it("executes the guarded update and reports whether the claim still exists", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const builder = {
      eq: (...args: unknown[]) => {
        calls.push(["eq", args]);
        return builder;
      },
      in: (...args: unknown[]) => {
        calls.push(["in", args]);
        return builder;
      },
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "flow-1" }, error: null }),
      select: (...args: unknown[]) => {
        calls.push(["select", args]);
        return builder;
      },
    };
    const update = vi.fn(() => builder);

    const published = await publishCursorLoginUrl({ from: () => ({ update }) } as never, {
      claimToken: "worker-1:claim-1",
      flowId: "flow-1",
      loginUrl: "https://cursor.com/login/flow-1",
    });

    expect(published).toBe(true);
    expect(update).toHaveBeenCalledWith({
      login_url: "https://cursor.com/login/flow-1",
      status: "prompted",
    });
    expect(calls).toEqual([
      ["eq", ["id", "flow-1"]],
      ["eq", ["claimed_by", "worker-1:claim-1"]],
      ["in", ["status", ["processing", "prompted"]]],
      ["select", ["id"]],
    ]);
    expect(builder.maybeSingle).toHaveBeenCalledTimes(1);
  });
});

describe("reclaimStaleCursorAuthFlows", () => {
  it("resets only unexpired processing leases older than the lease window", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const builder = {
      gt: (...args: unknown[]) => {
        calls.push(["gt", args]);
        return builder;
      },
      in: (...args: unknown[]) => {
        calls.push(["in", args]);
        return builder;
      },
      lt: (...args: unknown[]) => {
        calls.push(["lt", args]);
        return builder;
      },
      then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
    };
    const update = vi.fn(() => builder);
    const nowMs = Date.parse("2026-08-29T23:30:00.000Z");

    await reclaimStaleCursorAuthFlows({ from: () => ({ update }) } as never, nowMs);

    expect(update).toHaveBeenCalledWith({
      claimed_at: null,
      claimed_by: null,
      error_message: null,
      login_url: null,
      status: "starting",
    });
    expect(calls).toEqual([
      ["in", ["status", ["processing", "prompted"]]],
      ["lt", ["claimed_at", new Date(nowMs - CURSOR_AUTH_FLOW_LEASE_MS).toISOString()]],
      ["gt", ["expires_at", new Date(nowMs).toISOString()]],
    ]);
  });
});
