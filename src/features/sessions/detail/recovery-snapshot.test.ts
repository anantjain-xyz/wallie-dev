import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { RecoveryDeferredError } from "@/features/wallie/realtime-recovery";
import { loadSessionRecoverySnapshot, SessionRecoveryAccessError } from "./recovery-snapshot";
import type { SessionDetailRpcPayload } from "./review-data";

const detail: SessionDetailRpcPayload = {
  activity: {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    repository: null,
    sessionGithubRepositoryId: null,
  },
  creatorDisplayName: null,
  workspaceSlug: "acme",
  session: {
    id: "session-1",
    number: 7,
    title: "Review stage A",
    promptMd: "Task",
    archivedAt: null,
    createdAt: "2026-09-06T10:00:00Z",
    updatedAt: "2026-09-06T11:00:00Z",
    currentStageId: "stage-a",
    currentStageSlug: "plan",
    currentArtifactVersion: 1,
    phaseStatus: "awaiting_review",
    artifacts: [],
    phaseCompletions: [],
    pullRequests: [],
    linearIssueId: null,
    linearIssueUrl: null,
    pipeline: { stages: [] },
  },
};

function load(capabilitiesStageId: string | undefined, status = 200) {
  const rpc = vi.fn((name: string) => ({
    abortSignal: () =>
      Promise.resolve({
        data: name === "get_session_prompt_attachments" ? [] : detail,
        error: null,
      }),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          stageId: capabilitiesStageId,
          canApprove: true,
          hasFailedRun: false,
          failedStageSlug: null,
        },
        { status },
      ),
    ),
  );
  return loadSessionRecoverySnapshot({
    supabase: { rpc } as unknown as SupabaseClient<Database>,
    workspaceSlug: "acme",
    sessionNumber: 7,
    sessionId: "session-1",
    signal: new AbortController().signal,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("session recovery snapshot", () => {
  it("applies capabilities evaluated for the recovered stage", async () => {
    await expect(load("stage-a")).resolves.toMatchObject({
      review: { session: { currentStageId: "stage-a" } },
      canApprove: true,
    });
  });

  it("retries when the stage advances between detail and capabilities reads", async () => {
    await expect(load("stage-b")).rejects.toBeInstanceOf(RecoveryDeferredError);
  });

  it("rejects capabilities without the evaluated stage identity", async () => {
    await expect(load(undefined)).rejects.toThrow("Could not refresh review capabilities.");
  });

  it.each([401, 403, 404])(
    "treats HTTP %s as lost session access even with cached detail",
    async (status) => {
      await expect(load("stage-a", status)).rejects.toBeInstanceOf(SessionRecoveryAccessError);
    },
  );

  it("keeps transient server failures distinct from access loss", async () => {
    await expect(load("stage-a", 500)).rejects.not.toBeInstanceOf(SessionRecoveryAccessError);
  });
});
