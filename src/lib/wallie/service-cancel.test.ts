import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelWallieRun } from "@/lib/wallie/service";
import type { Tables } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ cancelSessionWork: vi.fn() }));
vi.mock("@/lib/pipeline/cancel", async () => ({
  ...(await vi.importActual<typeof import("@/lib/pipeline/cancel")>("@/lib/pipeline/cancel")),
  cancelSessionWork: mocks.cancelSessionWork,
}));

const workspace = { id: "workspace-1", name: "Acme", slug: "acme" };
const run = {
  id: "run-1",
  session_id: "session-1",
  workspace_id: workspace.id,
  agent_job_id: "job-1",
  attempt_count: 1,
  status: "running",
} as Tables<"agent_runs">;

function adminWithRuns(...rows: Array<Tables<"agent_runs"> | null>) {
  const maybeSingle = vi.fn();
  for (const row of rows) maybeSingle.mockResolvedValueOnce({ data: row, error: null });
  const query = { eq: vi.fn().mockReturnThis(), maybeSingle, select: vi.fn().mockReturnThis() };
  return { from: vi.fn(() => query) } as unknown as NonNullable<
    Parameters<typeof cancelWallieRun>[0]["admin"]
  >;
}

beforeEach(() => {
  mocks.cancelSessionWork.mockReset().mockResolvedValue({
    canceledJobIds: ["job-1"],
    canceledRunIds: [run.id],
    stoppedSandboxIds: [],
  });
});

describe("cancelWallieRun ownership", () => {
  it("passes the displayed run identity and workspace to cancellation", async () => {
    const canceled = { ...run, status: "canceled" } as const;
    const admin = adminWithRuns(run, canceled);
    const result = await cancelWallieRun({
      admin,
      requestedByMemberId: "member-1",
      runId: run.id,
      workspace,
    });
    expect(mocks.cancelSessionWork).toHaveBeenCalledWith(admin, {
      expectedRunId: run.id,
      parkPhaseStatus: true,
      reason: "Run canceled by a workspace member.",
      sessionId: run.session_id,
      workspaceId: workspace.id,
    });
    expect(result).toEqual({ canceled: true, run: canceled });
  });

  it("reports no cancellation when the displayed run lost ownership", async () => {
    mocks.cancelSessionWork.mockResolvedValue({
      canceledJobIds: [],
      canceledRunIds: [],
      stoppedSandboxIds: [],
    });
    const staleRun = { ...run, status: "error" } as const;
    const result = await cancelWallieRun({
      admin: adminWithRuns(run, staleRun),
      requestedByMemberId: "member-1",
      runId: run.id,
      workspace,
    });
    expect(result).toEqual({ canceled: false, run: staleRun });
  });

  it("returns terminal runs without cancelling replacement work", async () => {
    const terminalRun = { ...run, status: "success" } as const;
    const result = await cancelWallieRun({
      admin: adminWithRuns(terminalRun),
      requestedByMemberId: "member-1",
      runId: run.id,
      workspace,
    });
    expect(result).toEqual({ canceled: false, run: terminalRun });
    expect(mocks.cancelSessionWork).not.toHaveBeenCalled();
  });

  it("rejects a run belonging to another workspace before mutation", async () => {
    await expect(
      cancelWallieRun({
        admin: adminWithRuns({ ...run, workspace_id: "workspace-2" }),
        requestedByMemberId: "member-1",
        runId: run.id,
        workspace,
      }),
    ).rejects.toMatchObject({ code: "run_not_found", statusCode: 404 });
    expect(mocks.cancelSessionWork).not.toHaveBeenCalled();
  });
});
