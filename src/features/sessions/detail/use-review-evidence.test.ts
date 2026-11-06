// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";

import type { SupabasePublicConfig } from "@/lib/supabase/config";
import type { Database } from "@/lib/supabase/database.types";
import { reviewEvidenceDeliverySchema } from "./review-evidence-contracts";
import { useReviewEvidence } from "./use-review-evidence";

const mocked = vi.hoisted(() => ({
  config: null as SupabasePublicConfig | null,
  loadClient: vi.fn<() => Promise<SupabaseClient<Database>>>(),
}));

vi.mock("@/lib/supabase/public-config-provider", () => ({
  useSupabasePublicConfig: () => mocked.config,
}));
vi.mock("@/lib/supabase/deferred-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/deferred-browser")>()),
  loadSupabaseBrowserClient: mocked.loadClient,
}));

const sha = "a".repeat(40);
const baseSha = "b".repeat(40);

function delivery(
  overrides: {
    observedAt?: string;
    state?: "ready" | "blocked";
  } = {},
) {
  const state = overrides.state ?? "ready";
  return reviewEvidenceDeliverySchema.parse({
    requirements: {
      version: 1,
      deliveryMode: "code",
      requiredChecks: [],
      minimumApprovals: 1,
      requireCodeOwnerReview: false,
      requireResolvedThreads: true,
      requiredEvidence: [],
      freshnessSeconds: 60,
      requireArtifactApprovalForDelivery: true,
    },
    policyRevisionId: "33333333-3333-4333-8333-333333333333",
    finalStage: true,
    approvalGated: true,
    observationStale: false,
    evaluation: {
      state,
      blockers: state === "blocked" ? [{ code: "github_checks_not_passed" }] : [],
      dimensions: {
        githubAccess: "passed",
        identity: "passed",
        checks: state === "ready" ? "passed" : "blocked",
        reviews: "passed",
        threads: "passed",
        evidence: "passed",
        mergeability: "passed",
      },
      summary:
        state === "ready"
          ? {
              githubAccess: "available",
              checks: "passed",
              reviews: "passed",
              evidence: "passed",
              threads: "passed",
            }
          : null,
    },
    pr: {
      repositoryFullName: "acme/app",
      repositoryUrl: "https://github.com/acme/app",
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      state: "open",
      draft: false,
      headSha: sha,
      baseSha,
      observedAt: overrides.observedAt ?? "2026-11-06T00:00:00Z",
    },
    checks: [],
    review: null,
    evidence: {
      runId: null,
      commitSha: null,
      validationTreeSha: null,
      createdAt: null,
      required: [],
      records: [],
      assets: [],
    },
    artifactBlockingCount: 0,
    refresh: {
      status: "current",
      lastErrorCode: null,
      updatedAt: "2026-11-06T00:00:00Z",
      canRefresh: true,
    },
    sourceObservationId: "44444444-4444-4444-8444-444444444444",
  });
}

function realtimeClient() {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "session-token" } },
        error: null,
      }),
    },
    realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return { client: client as unknown as SupabaseClient<Database>, calls: client, channel };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mocked.config = null;
  mocked.loadClient.mockReset();
});

it("reloads when the observation reaches its freshness limit", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ delivery: delivery({ observedAt: "2026-11-05T23:59:30Z" }) }),
    )
    .mockResolvedValueOnce(
      Response.json({
        delivery: delivery({
          observedAt: "2026-11-05T23:59:30Z",
          state: "blocked",
        }),
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useReviewEvidence("session"));
  await act(async () => {});
  expect(result.current.value?.evaluation.state).toBe("ready");
  await act(async () => vi.advanceTimersByTimeAsync(31_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.current.value?.evaluation.state).toBe("blocked");
});

it("reloads when review threads, the refresh queue, or observations change", async () => {
  mocked.config = { url: "https://example.supabase.co", publishableKey: "public-key" };
  const realtime = realtimeClient();
  mocked.loadClient.mockResolvedValue(realtime.client);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ delivery: delivery() }));
  vi.stubGlobal("fetch", fetcher);
  const { result, unmount } = renderHook(() => useReviewEvidence("session"));
  await waitFor(() => expect(result.current.value?.evaluation.state).toBe("ready"));
  await waitFor(() => expect(realtime.channel.subscribe).toHaveBeenCalled());
  expect(
    realtime.channel.on.mock.calls.map((call) => (call[1] as { table: string }).table),
  ).toEqual([
    "artifact_review_threads",
    "session_pr_refresh_queue",
    "session_pr_verification_observations",
  ]);
  const before = fetcher.mock.calls.length;
  act(() => {
    for (const call of realtime.channel.on.mock.calls) {
      (call[2] as () => void)();
    }
  });
  await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before));
  unmount();
  expect(realtime.calls.removeChannel).toHaveBeenCalledOnce();
});
