import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

const mocks = vi.hoisted(() => ({
  observations: vi.fn(),
  routing: vi.fn(),
  cleanup: vi.fn(),
  runConfig: vi.fn(),
  decrypt: vi.fn<(value: string) => string>(),
}));
vi.mock("@/lib/linear-routing/observations", async (original) => ({
  ...(await original<typeof import("@/lib/linear-routing/observations")>()),
  fetchLinearStateObservations: mocks.observations,
}));
vi.mock("@/lib/linear-routing/server", () => ({ loadLinearRoutingSnapshot: mocks.routing }));
vi.mock("@/lib/pipeline/cancel", () => ({ cleanupSessionWorkReceipt: mocks.cleanup }));
vi.mock("@/lib/wallie/service", () => ({ resolveQueuedRunConfig: mocks.runConfig }));
vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocks.decrypt,
}));
import { reconcileLinearState } from "./reconciler";
import { LinearRateLimitedError } from "@/lib/linear-routing/observations";

const updatedAt = "2026-10-02T00:00:00Z";
const observation = {
  issueId: "66310000-0000-4000-8000-000000000001",
  issueUpdatedAt: updatedAt,
  spanId: "span-1",
  startedAt: updatedAt,
  stateId: "state-1",
  statusName: "Rework",
  teamId: "team-1",
  projectId: null,
};
const session = (id = "session-1", workspace = "workspace-1", phase = "awaiting_review") => ({
  id,
  workspace_id: workspace,
  linear_issue_id: `ISSUE-${id}`,
  updated_at: updatedAt,
  phase_status: phase,
});
function adminFor(
  rows = [session()],
  credentials = [...new Set(rows.map((row) => row.workspace_id))].map((workspace_id) => ({
    workspace_id,
    encrypted_value: workspace_id,
  })),
) {
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
  const readCursor = vi.fn().mockResolvedValue({
    data: [{ after_session_id: null, generation: 0 }],
    error: null,
  });
  const commitPage = vi.fn(
    (input: {
      p_session_ids: string[];
      p_expected_generation: number;
      p_workspace_id: string;
      p_observations: unknown[];
    }): Promise<{ data: unknown; error: { code: string; message: string } | null }> =>
      Promise.resolve({
        data: [
          {
            after_session_id: input.p_session_ids.length === 50 ? input.p_session_ids.at(-1) : null,
            generation: input.p_expected_generation + 1,
            occurrence_count: 0,
          },
        ],
        error: null,
      }),
  );
  const retainSpan = vi.fn().mockResolvedValue({ data: true, error: null });
  const admin = {
    rpc(name: string, input: never) {
      if (name === "read_linear_automation_span_cursor") return readCursor(name, input);
      if (name === "commit_linear_automation_span_page") return commitPage(input);
      if (name === "retain_terminal_linear_automation_span") return retainSpan(name, input);
      return rpc(name, input);
    },
    from(table: string) {
      if (!["sessions", "workspace_secrets"].includes(table))
        throw new Error(`Unexpected direct read/write ${table}`);
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        not: () => builder,
        is: () => builder,
        in: (column: string, values: string[]) => {
          filters[`in.${column}`] = values;
          return builder;
        },
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
                  ? credentials.filter((row) =>
                      (filters["in.workspace_id"] as string[]).includes(row.workspace_id),
                    )
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
  return { admin, rpc, reads, readCursor, commitPage, retainSpan };
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
  mocks.decrypt.mockImplementation((value) => `decoded:${value}`);
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
  it("keeps legacy routing closed when configuration is unavailable while retaining the provider span", async () => {
    mocks.routing.mockRejectedValue(new Error("configuration query failed"));
    const { admin, rpc, commitPage } = adminFor();
    await reconcileLinearState(admin as never);
    expect(rpc).not.toHaveBeenCalled();
    expect(commitPage).toHaveBeenCalledOnce();
  });
  it("fails closed on incomplete source history", async () => {
    mocks.observations.mockRejectedValue(new Error("missing open span"));
    const { admin, rpc, commitPage } = adminFor();
    await reconcileLinearState(admin as never);
    expect(rpc).not.toHaveBeenCalled();
    expect(commitPage).not.toHaveBeenCalled();
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
  it("restarts from the persisted linked-session cursor with exact provider scope", async () => {
    const { admin, reads, readCursor, commitPage, rpc } = adminFor([
      session(),
      session("session-2"),
    ]);
    readCursor.mockResolvedValue({
      data: [{ after_session_id: "session-1", generation: 7 }],
      error: null,
    });

    await reconcileLinearState(admin as never, { workspaceId: "workspace-1" });

    const sessionReads = reads.filter((read) => read.table === "sessions");
    expect(sessionReads[0]?.filters).toMatchObject({ workspace_id: "workspace-1" });
    expect(sessionReads[0]?.filters).not.toHaveProperty("gt.id");
    expect(sessionReads[1]?.filters).toMatchObject({
      "gt.id": "session-1",
      workspace_id: "workspace-1",
    });
    expect(mocks.observations).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      "apply_linear_session_transition",
      expect.objectContaining({ p_session_id: "session-1" }),
    );
    expect(commitPage).toHaveBeenCalledExactlyOnceWith({
      p_expected_generation: 7,
      p_session_ids: ["session-2"],
      p_workspace_id: "workspace-1",
      p_observations: [
        {
          sessionId: "session-2",
          linkedIssueId: "ISSUE-session-2",
          issueId: observation.issueId,
          spanId: observation.spanId,
          startedAt: updatedAt,
          issueUpdatedAt: updatedAt,
          stateId: "state-1",
          teamId: "team-1",
          projectId: null,
        },
      ],
    });
    expect(rpc).toHaveBeenCalledWith(
      "apply_linear_session_transition",
      expect.objectContaining({ p_session_id: "session-2" }),
    );
  });
  it("routes the healthy prefix on every sweep while a later automation page keeps failing", async () => {
    const { admin, readCursor, commitPage, rpc } = adminFor(
      Array.from({ length: 51 }, (_, index) =>
        session(`session-${String(index).padStart(3, "0")}`),
      ),
    );
    readCursor.mockResolvedValue({
      data: [{ after_session_id: "session-049", generation: 7 }],
      error: null,
    });
    commitPage.mockResolvedValue({
      data: [],
      error: { code: "XX000", message: "write unavailable" },
    });
    mocks.observations
      .mockImplementationOnce(
        async (_key: string, ids: string[]) =>
          new Map(ids.map((id) => [id, { ...observation, statusName: "Todo" }])),
      )
      .mockImplementationOnce(
        async (_key: string, ids: string[]) => new Map(ids.map((id) => [id, observation])),
      )
      .mockImplementationOnce(
        async (_key: string, ids: string[]) =>
          new Map(
            ids.map((id) => [
              id,
              { ...observation, spanId: "prefix-new", statusName: "In Review" },
            ]),
          ),
      );

    await reconcileLinearState(admin as never);
    await reconcileLinearState(admin as never);

    const prefix = rpc.mock.calls.filter(([, args]) => args.p_session_id === "session-000");
    expect(prefix.map(([, args]) => args.p_status_name)).toEqual(["Todo", "In Review"]);
    expect(mocks.observations).toHaveBeenCalledTimes(4);
    expect(commitPage).toHaveBeenCalledTimes(2);
    for (const [page] of commitPage.mock.calls) {
      expect(page).toMatchObject({ p_expected_generation: 7, p_session_ids: ["session-050"] });
    }
  });

  it.each(["Canceled", "Done"])(
    "keeps the sole link on span write failure before %s and routes it after durable retention",
    async (statusName) => {
      const { admin, commitPage, retainSpan, rpc } = adminFor([session(), session("session-2")]);
      commitPage.mockResolvedValue({
        data: [],
        error: { code: "XX000", message: "write unavailable" },
      });
      retainSpan.mockResolvedValueOnce({
        data: null,
        error: { message: "single span write unavailable" },
      });
      mocks.observations.mockImplementation(
        async (_key: string, ids: string[]) =>
          new Map(
            ids.map((id) => [
              id,
              id === "ISSUE-session-1" ? { ...observation, statusName } : observation,
            ]),
          ),
      );

      await reconcileLinearState(admin as never);
      expect(rpc).toHaveBeenCalledExactlyOnceWith(
        "apply_linear_session_transition",
        expect.objectContaining({ p_session_id: "session-2" }),
      );
      expect(retainSpan).toHaveBeenCalledWith("retain_terminal_linear_automation_span", {
        p_workspace_id: "workspace-1",
        p_observation: {
          sessionId: "session-1",
          linkedIssueId: "ISSUE-session-1",
          issueId: observation.issueId,
          spanId: observation.spanId,
          startedAt: updatedAt,
          issueUpdatedAt: updatedAt,
          stateId: observation.stateId,
          teamId: observation.teamId,
          projectId: null,
        },
      });

      rpc.mockClear();
      await reconcileLinearState(admin as never);
      expect(rpc).toHaveBeenCalledWith(
        "apply_linear_session_transition",
        expect.objectContaining({ p_session_id: "session-1", p_status_name: statusName }),
      );
      expect(retainSpan.mock.invocationCallOrder[1]).toBeLessThan(rpc.mock.invocationCallOrder[0]!);
    },
  );
  it("resumes each workspace independently when another workspace keeps failing", async () => {
    const { admin, commitPage, readCursor, rpc } = adminFor([
      session(),
      session("session-2", "workspace-2"),
    ]);
    readCursor.mockResolvedValue({
      data: [{ after_session_id: null, generation: 7 }],
      error: null,
    });
    mocks.observations.mockImplementation(async (key: string, ids: string[]) => {
      if (key === "decoded:workspace-1") throw new Error("incomplete history");
      return new Map(ids.map((id) => [id, observation]));
    });

    await reconcileLinearState(admin as never);
    await reconcileLinearState(admin as never);

    expect(mocks.observations).toHaveBeenCalledTimes(4);
    expect(commitPage).toHaveBeenCalledTimes(2);
    for (const [page] of commitPage.mock.calls) {
      expect(page).toMatchObject({
        p_expected_generation: 7,
        p_session_ids: ["session-2"],
        p_workspace_id: "workspace-2",
        p_observations: [expect.objectContaining({ sessionId: "session-2" })],
      });
    }
    for (const [, input] of readCursor.mock.calls) {
      expect(input).toEqual({ p_workspace_id: "workspace-2" });
    }
    expect(rpc.mock.calls.map(([, input]) => input.p_session_id)).toEqual([
      "session-2",
      "session-2",
    ]);
  });

  it("holds the unreadable credential workspace and skips an unconfigured workspace normally", async () => {
    const { admin, commitPage } = adminFor(
      [session(), session("session-2", "workspace-2"), session("session-3", "workspace-3")],
      [
        { workspace_id: "workspace-1", encrypted_value: "unreadable-fixture-material" },
        { workspace_id: "workspace-2", encrypted_value: "valid-fixture" },
      ],
    );
    mocks.decrypt.mockImplementation((value) => {
      if (value === "unreadable-fixture-material") throw new Error(value);
      return `decoded:${value}`;
    });

    await reconcileLinearState(admin as never);

    expect(mocks.observations).toHaveBeenCalledExactlyOnceWith(
      "decoded:valid-fixture",
      ["ISSUE-session-2"],
      expect.any(Function),
    );
    expect(commitPage.mock.calls.map(([page]) => page.p_workspace_id)).toEqual([
      "workspace-2",
      "workspace-3",
    ]);
    expect(commitPage.mock.calls[1]?.[0]).toMatchObject({
      p_observations: [],
      p_session_ids: ["session-3"],
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[reconciler] failed to decrypt Linear API key",
      { workspaceId: "workspace-1" },
    );
  });

  it("holds only the throttled workspace and advances healthy scopes on both sides", async () => {
    mocks.observations.mockImplementation(async (key: string, ids: string[]) => {
      if (key === "decoded:workspace-2") throw new LinearRateLimitedError();
      return new Map(ids.map((id) => [id, observation]));
    });
    const { admin, rpc, commitPage } = adminFor([
      session(),
      session("session-2", "workspace-2"),
      session("session-3", "workspace-3"),
    ]);

    expect((await reconcileLinearState(admin as never)).rateLimited).toBe(true);

    expect(commitPage.mock.calls.map(([page]) => page.p_workspace_id)).toEqual([
      "workspace-1",
      "workspace-3",
    ]);
    expect(rpc.mock.calls.map(([, input]) => input.p_session_id)).toEqual([
      "session-1",
      "session-3",
    ]);
  });
  it("uses a unique ID cursor so equal creation timestamps cannot skip a page", async () => {
    const { admin, rpc, reads } = adminFor(
      Array.from({ length: 51 }, (_, index) =>
        session(`session-${String(index).padStart(3, "0")}`),
      ),
    );
    await reconcileLinearState(admin as never);
    expect(rpc).toHaveBeenCalledTimes(51);
    expect(
      reads.filter((read) => read.table === "sessions" && !read.filters.workspace_id)[1]?.filters,
    ).toMatchObject({
      order: "id",
      "gt.id": "session-049",
    });
  });
});
