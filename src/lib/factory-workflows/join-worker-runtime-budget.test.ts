import { createClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";
import {
  ExecutionBudgetExhaustedError,
  loadSessionExecutionBudget,
} from "@/lib/pipeline/execution-budget";
import type { Database } from "@/lib/supabase/database.types";
import { processFactoryWorkflowJoinJob, type ManagedResources } from "./join-worker-runtime";

vi.mock(import("@/lib/pipeline/execution-budget"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadSessionExecutionBudget: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("reports the persisted elapsed budget deadline while the post-claim budget read is pending", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const budgetRead = Promise.withResolvers<null>();
  vi.mocked(loadSessionExecutionBudget).mockReturnValue(budgetRead.promise);

  const claim = {
    kind: "started",
    rootSessionId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    factoryId: "00000000-0000-4000-8000-000000000003",
    parentSessionId: "00000000-0000-4000-8000-000000000004",
    joinId: "00000000-0000-4000-8000-000000000005",
    jobId: "00000000-0000-4000-8000-000000000006",
    runId: "00000000-0000-4000-8000-000000000007",
    ownershipToken: "00000000-0000-4000-8000-000000000008",
    attemptCount: 1,
    generation: 3,
    artifactVersion: 2,
    baseSha: "a".repeat(40),
    baseRef: null,
    deadlineAt: new Date(now + 50).toISOString(),
    deadlineReason: "elapsed_execution",
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(claim));
  const admin = createClient<Database>("https://supabase.invalid", "test-only", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  const resources = {
    integrate: vi.fn(),
    validate: vi.fn(),
    conflicts: vi.fn(),
  } satisfies ManagedResources;
  const settled = vi.fn<(result: unknown) => void>();
  void processFactoryWorkflowJoinJob({
    admin,
    job: {
      id: claim.jobId,
      workspace_id: claim.workspaceId,
      session_id: claim.parentSessionId,
      attempt_count: claim.attemptCount,
    },
    deadlineAt: new Date(now + 5_000).toISOString(),
    signal: new AbortController().signal,
    resources,
  }).then(settled, settled);

  await vi.advanceTimersByTimeAsync(49);
  expect(loadSessionExecutionBudget).toHaveBeenCalledExactlyOnceWith(admin, claim.parentSessionId);
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: "elapsed_execution" }),
  );
  expect(settled.mock.lastCall?.[0]).toBeInstanceOf(ExecutionBudgetExhaustedError);

  budgetRead.resolve(null);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(resources.integrate).not.toHaveBeenCalled();
  expect(resources.validate).not.toHaveBeenCalled();
});
