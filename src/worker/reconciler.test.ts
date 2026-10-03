import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

const mocks = vi.hoisted(() => ({
  observations: vi.fn(),
  routing: vi.fn(),
  cleanup: vi.fn(),
  runConfig: vi.fn(),
}));
vi.mock("@/lib/linear-routing/observations", async (original) => ({
  ...(await original<typeof import("@/lib/linear-routing/observations")>()),
  fetchLinearStateObservations: mocks.observations,
}));
vi.mock("@/lib/linear-routing/server", () => ({ loadLinearRoutingSnapshot: mocks.routing }));
vi.mock("@/lib/pipeline/cancel", () => ({ cleanupSessionWorkReceipt: mocks.cleanup }));
vi.mock("@/lib/wallie/service", () => ({ resolveQueuedRunConfig: mocks.runConfig }));
vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: (value: string) => `decoded:${value}`,
}));
import { reconcileLinearState } from "./reconciler";
import { LinearRateLimitedError } from "@/lib/linear-routing/observations";

const updatedAt = "2026-10-02T00:00:00Z";
const observation = {
  issueUpdatedAt: updatedAt,
  spanId: "span-1",
  startedAt: updatedAt,
  stateId: "state-1",
  statusName: "Rework",
};
const session = (id = "session-1", workspace = "workspace-1", phase = "awaiting_review") => ({
  id,
  workspace_id: workspace,
  linear_issue_id: `ISSUE-${id}`,
  updated_at: updatedAt,
  phase_status: phase,
});
function adminFor(rows = [session()]) {
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const rpc = vi.fn().mockResolvedValue({
    data: [
      {
        outcome: "routed",
        job_ids: ["old-job"],
        run_ids: ["old-run"],
        job_id: "new-job",
        run_id: "new-run",
      },
    ],
    error: null,
  });
  const admin = {
    rpc,
    from(table: string) {
      if (!["sessions", "workspace_secrets"].includes(table))
        throw new Error(`Unexpected direct read/write ${table}`);
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        not: () => builder,
        is: () => builder,
        in: () => builder,
        order: (column: string) => {
          filters.order = column;
          return builder;
        },
        limit: (limit: number) => {
          filters.limit = limit;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        gt: (column: string, value: string) => {
          filters[`gt.${column}`] = value;
          return builder;
        },
        then(resolve: (value: unknown) => unknown) {
          reads.push({ table, filters });
          return Promise.resolve(
            resolve({
              error: null,
              data:
                table === "workspace_secrets"
                  ? [...new Set(rows.map((row) => row.workspace_id))].map((workspace_id) => ({
                      workspace_id,
                      encrypted_value: workspace_id,
                    }))
                  : rows
                      .filter(
                        (row) =>
                          (!filters.workspace_id || row.workspace_id === filters.workspace_id) &&
                          (!filters["gt.id"] || row.id > String(filters["gt.id"])),
                      )
                      .slice(0, 50),
            }),
          );
        },
      };
      return builder;
    },
  };
  return { admin, rpc, reads };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.routing.mockResolvedValue({ config: DEFAULT_LINEAR_ROUTING_CONFIG, updatedAt });
  mocks.observations.mockImplementation(
    async (_key: string, ids: string[]) => new Map(ids.map((id) => [id, observation])),
  );
  mocks.runConfig.mockResolvedValue({
    modelName: "model",
    modelProvider: "codex",
    runType: "project",
  });
  mocks.cleanup.mockResolvedValue(undefined);
});

describe("reconcileLinearState", () => {
  it("passes source identity and both database snapshots to one atomic transition", async () => {
    const { admin, rpc } = adminFor();
    await expect(reconcileLinearState(admin as never)).resolves.toEqual({
      checked: 1,
      canceled: 0,
      rateLimited: false,
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("apply_linear_session_transition", {
      p_session_id: "session-1",
      p_workspace_id: "workspace-1",
      p_linear_issue_id: "ISSUE-session-1",
      p_expected_session_updated_at: updatedAt,
      p_expected_routing_updated_at: updatedAt,
      p_source_span_id: "span-1",
      p_source_started_at: updatedAt,
      p_source_state_id: "state-1",
      p_source_issue_updated_at: updatedAt,
      p_status_name: "Rework",
      p_agent_model_provider: "codex",
      p_agent_model_name: "model",
      p_run_type: "project",
    });
    expect(mocks.cleanup).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        receipt: expect.objectContaining({ run_ids: ["old-run"], job_ids: ["old-job"] }),
        workspaceId: "workspace-1",
      }),
    );
  });
  it("awaits committed cancellation before cleanup and performs no later session mutation", async () => {
    const { admin, rpc, reads } = adminFor();
    let finish!: (value: unknown) => void;
    rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const work = reconcileLinearState(admin as never);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(mocks.cleanup).not.toHaveBeenCalled();
    finish({
      data: [{ outcome: "routed", job_ids: ["old-job"], run_ids: ["old-run"] }],
      error: null,
    });
    mocks.cleanup.mockImplementation(async () => {
      const priorReads = reads.length;
      await Promise.resolve(); // A replacement may already start while stop is pending.
      expect(reads).toHaveLength(priorReads);
    });
    await work;
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each(["Backlog", "In Review", "Unknown", "Merging"])(
    "records %s without requiring run configuration",
    async (statusName) => {
      mocks.observations.mockResolvedValue(
        new Map([["ISSUE-session-1", { ...observation, statusName }]]),
      );
      const { admin, rpc } = adminFor();
      await reconcileLinearState(admin as never);
      expect(rpc).toHaveBeenCalledWith(
        "apply_linear_session_transition",
        expect.objectContaining({ p_status_name: statusName }),
      );
      expect(mocks.runConfig).not.toHaveBeenCalled();
    },
  );
  it("does not prepare another run when Todo is observed during review", async () => {
    mocks.observations.mockResolvedValue(
      new Map([["ISSUE-session-1", { ...observation, statusName: "Todo" }]]),
    );
    const { admin, rpc } = adminFor();
    await reconcileLinearState(admin as never);
    expect(rpc).toHaveBeenCalled();
    expect(mocks.runConfig).not.toHaveBeenCalled();
  });
  it("counts only committed canceled dispositions", async () => {
    const { admin, rpc } = adminFor();
    rpc.mockResolvedValue({
      data: [{ outcome: "archived", run_ids: [], job_ids: [] }],
      error: null,
    });
    expect((await reconcileLinearState(admin as never)).canceled).toBe(1);
  });
  it("never cleans up IDs from a failed transaction", async () => {
    const { admin, rpc } = adminFor();
    rpc.mockResolvedValue({ data: null, error: { message: "enqueue failed" } });
    await reconcileLinearState(admin as never);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it("continues after an individual transition fails", async () => {
    const { admin, rpc } = adminFor([session(), session("session-2")]);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "temporary failure" } });
    await reconcileLinearState(admin as never);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });
  it("fails closed when configuration could not be read", async () => {
    mocks.routing.mockRejectedValue(new Error("configuration query failed"));
    const { admin, rpc } = adminFor();
    await reconcileLinearState(admin as never);
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.observations).not.toHaveBeenCalled();
  });
  it("fails closed on incomplete source history", async () => {
    mocks.observations.mockRejectedValue(new Error("missing open span"));
    const { admin, rpc } = adminFor();
    await reconcileLinearState(admin as never);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("aborts a sweep on persistent source rate limit", async () => {
    mocks.observations.mockRejectedValue(new LinearRateLimitedError());
    const { admin, rpc } = adminFor();
    expect((await reconcileLinearState(admin as never)).rateLimited).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("batches source reads once per workspace", async () => {
    const { admin } = adminFor([
      session(),
      session("session-2"),
      session("session-3", "workspace-2"),
    ]);
    await reconcileLinearState(admin as never);
    expect(mocks.observations).toHaveBeenCalledTimes(2);
    expect(mocks.observations).toHaveBeenCalledWith(
      "decoded:workspace-1",
      ["ISSUE-session-1", "ISSUE-session-2"],
      expect.any(Function),
    );
  });
  it("honors manual workspace scope", async () => {
    const { admin, rpc } = adminFor([session(), session("session-2", "workspace-2")]);
    await reconcileLinearState(admin as never, { workspaceId: "workspace-2" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ p_workspace_id: "workspace-2" }),
    );
  });
  it("uses a unique ID cursor so equal creation timestamps cannot skip a page", async () => {
    const { admin, rpc, reads } = adminFor(
      Array.from({ length: 51 }, (_, index) =>
        session(`session-${String(index).padStart(3, "0")}`),
      ),
    );
    await reconcileLinearState(admin as never);
    expect(rpc).toHaveBeenCalledTimes(51);
    expect(reads.filter((read) => read.table === "sessions")[1]?.filters).toMatchObject({
      order: "id",
      "gt.id": "session-049",
    });
  });
});
