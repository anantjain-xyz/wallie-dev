import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { drainSlackReviewActionBatch, drainSlackReviewActions } from "./review-actions";

const mocks = vi.hoisted(() => ({
  resolveQueuedRunConfig: vi.fn(),
  evaluateSessionPrReadiness: vi.fn(),
  wakeWorker: vi.fn(),
}));
vi.mock("@/lib/wallie/service", () => ({ resolveQueuedRunConfig: mocks.resolveQueuedRunConfig }));
vi.mock("@/lib/pipeline/pr-readiness", () => ({
  evaluateSessionPrReadiness: mocks.evaluateSessionPrReadiness,
}));
vi.mock("@/lib/worker/wake", () => ({ wakeWorker: mocks.wakeWorker }));

const claim = {
  kind: "action",
  action_id: "67800000-0000-4000-8000-000000000101",
  lease_id: "67800000-0000-4000-8000-000000000102",
  workspace_id: "67800000-0000-4000-8000-000000000103",
  session_id: "67800000-0000-4000-8000-000000000104",
  action: "approve",
};
const cleanup = [{ kind: "cleanup", action_id: null, lease_id: null }];
const claimRpc = "/rest/v1/rpc/claim_slack_review_action";
const completeRpc = "/rest/v1/rpc/complete_slack_review_action";

function fakeAdmin(responses: unknown[]) {
  const outbound: Array<{ path: string; args: unknown; signal: AbortSignal | null | undefined }> =
    [];
  const mockedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    outbound.push({
      path: new URL(request.url).pathname,
      args: await request.json(),
      signal: init?.signal,
    });
    const result = responses.shift();
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error("Unexpected RPC request.");
    return Response.json(result);
  };
  const client = createClient<Database>("http://localhost:1", "review-fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: mockedFetch },
  });
  return { client, outbound };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveQueuedRunConfig.mockResolvedValue({
    modelProvider: "codex",
    modelName: "gpt-5.5",
    runType: "code",
  });
});

describe("Slack review action drain", () => {
  it("makes no claim when the Node worker is already draining", async () => {
    const { client, outbound } = fakeAdmin([]);

    await expect(drainSlackReviewActions(client, { isShuttingDown: () => true })).resolves.toBe(0);

    expect(outbound).toEqual([]);
  });

  it("settles the action already held when shutdown begins, then wakes the worker", async () => {
    const { client, outbound } = fakeAdmin([[claim], "applied"]);
    let draining = false;
    mocks.evaluateSessionPrReadiness.mockImplementationOnce(() => {
      draining = true;
    });

    await expect(
      drainSlackReviewActions(client, {
        workspaceId: claim.workspace_id,
        isShuttingDown: () => draining,
      }),
    ).resolves.toBe(1);

    expect(outbound).toEqual([
      {
        path: claimRpc,
        args: { p_workspace_id: claim.workspace_id },
        signal: expect.any(AbortSignal),
      },
      {
        path: completeRpc,
        args: {
          p_action_id: claim.action_id,
          p_lease_id: claim.lease_id,
          p_agent_model_provider: "codex",
          p_agent_model_name: "gpt-5.5",
          p_run_type: "code",
        },
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(mocks.wakeWorker).toHaveBeenCalledOnce();
  });

  it("continues past cleanup and stops at an empty queue", async () => {
    const { client, outbound } = fakeAdmin([cleanup, [claim], "applied", []]);

    await expect(drainSlackReviewActions(client)).resolves.toBe(1);

    expect(outbound.map(({ path }) => path)).toEqual([claimRpc, claimRpc, completeRpc, claimRpc]);
    expect(mocks.resolveQueuedRunConfig).toHaveBeenCalledOnce();
  });

  it("reports a full batch so the fifth approval can be drained without another tick", async () => {
    const { client, outbound } = fakeAdmin([
      ...Array.from({ length: 5 }, () => [[claim], "applied"]).flat(),
      [],
    ]);

    await expect(drainSlackReviewActionBatch(client)).resolves.toEqual({
      applied: 4,
      hasMore: true,
    });
    await expect(drainSlackReviewActionBatch(client)).resolves.toEqual({
      applied: 1,
      hasMore: false,
    });

    expect(outbound.filter(({ path }) => path === completeRpc)).toHaveLength(5);
    expect(mocks.wakeWorker).toHaveBeenCalledTimes(2);
  });

  it("suppresses continuation when shutdown begins during the last full-batch action", async () => {
    const { client, outbound } = fakeAdmin(
      Array.from({ length: 4 }, () => [[claim], "applied"]).flat(),
    );
    const isShuttingDown = () => mocks.evaluateSessionPrReadiness.mock.calls.length === 4;

    await expect(drainSlackReviewActionBatch(client, { isShuttingDown })).resolves.toEqual({
      applied: 4,
      hasMore: false,
    });
    expect(outbound.at(-1)?.path).toBe(completeRpc);
    expect(mocks.wakeWorker).toHaveBeenCalledOnce();
  });

  it("bounds the number of cleanup-only claims", async () => {
    const { client, outbound } = fakeAdmin(Array.from({ length: 4 }, () => cleanup));

    await expect(drainSlackReviewActions(client)).resolves.toBe(0);

    expect(outbound.map(({ path }) => path)).toEqual([claimRpc, claimRpc, claimRpc, claimRpc]);
    expect(mocks.resolveQueuedRunConfig).not.toHaveBeenCalled();
  });

  it.each(["claim", "settle"] as const)(
    "bounds a timed-out %s RPC and lets the lease govern recovery",
    async (phase) => {
      using timeout = vi.spyOn(AbortSignal, "timeout");
      const failure = new DOMException("Fixture RPC timeout", "TimeoutError");
      const { client, outbound } = fakeAdmin(phase === "claim" ? [failure] : [[claim], failure]);

      await expect(drainSlackReviewActions(client)).rejects.toThrow(
        `Could not ${phase} a Slack review action.`,
      );

      expect(outbound.map(({ path }) => path)).toEqual(
        phase === "claim" ? [claimRpc] : [claimRpc, completeRpc],
      );
      for (const [index, request] of outbound.entries()) {
        expect(timeout).toHaveBeenNthCalledWith(index + 1, 5_000);
        expect(request.signal).toBe(timeout.mock.results[index]?.value);
      }
      expect(mocks.wakeWorker).not.toHaveBeenCalled();
    },
  );
});
