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
const linked = (id: string) => ({ sessionId: id, linkedIssueId: `ISSUE-${id}` });
function adminFor(
  rows = [session()],
  credentials = [...new Set(rows.map((row) => row.workspace_id))].map((workspace_id) => ({
    workspace_id,
    encrypted_value: workspace_id,
  })),
  waitBeforeRead?: (table: string, filters: Record<string, unknown>) => Promise<void> | undefined,
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
      p_session_links: Array<ReturnType<typeof linked>>;
      p_expected_generation: number;
      p_workspace_id: string;
      p_observations: unknown[];
    }): Promise<{ data: unknown; error: { code: string; message: string } | null }> =>
      Promise.resolve({
        data: [
          {
            after_session_id:
              input.p_session_links.length === 50 ? input.p_session_links.at(-1)?.sessionId : null,
            generation: input.p_expected_generation + 1,
            occurrence_count: 0,
          },
        ],
        error: null,
      }),
  );
  const terminalRpc = vi.fn().mockResolvedValue({
    data: [{ outcome: "archived", job_ids: [], run_ids: [] }],
    error: null,
  });
  const admin = {
    rpc(name: string, input: never) {
      if (name === "read_linear_automation_span_cursor") return readCursor(name, input);
      if (name === "commit_linear_automation_span_page") return commitPage(input);
      if (name === "apply_terminal_linear_session_transition") return terminalRpc(name, input);
      return rpc(name, input);
    },
    from(table: string) {
      if (!["sessions", "workspace_secrets"].includes(table))
        throw new Error(`Unexpected direct read/write ${table}`);
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        neq: (column: string, value: unknown) => {
          filters[`neq.${column}`] = value;
          return builder;
        },
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
          const finish = () =>
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
                          (!("neq.linear_issue_id" in filters) ||
                            row.linear_issue_id !== filters["neq.linear_issue_id"]) &&
                          (!filters["gt.id"] || row.id > String(filters["gt.id"])),
                      )
                      .slice(0, 50),
            });
          const pending = waitBeforeRead?.(table, filters);
          return pending ? pending.then(finish) : Promise.resolve(finish());
        },
      };
      return builder;
    },
  };
  return { admin, rpc, reads, readCursor, commitPage, terminalRpc };
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
  it("loads the routing snapshot before observing a terminal lifecycle state", async () => {
    const routing = Promise.withResolvers<{
      config: typeof DEFAULT_LINEAR_ROUTING_CONFIG;
      updatedAt: string;
    }>();
    mocks.routing.mockReturnValueOnce(routing.promise);
    mocks.observations.mockResolvedValue(
      new Map([["ISSUE-session-1", { ...observation, statusName: "Canceled" }]]),
    );
    const { admin, terminalRpc } = adminFor();

    const work = reconcileLinearState(admin as never);
    try {
      await vi.waitFor(() =>
        expect(mocks.routing).toHaveBeenCalledExactlyOnceWith(admin, "workspace-1"),
      );
      expect(mocks.observations).not.toHaveBeenCalled();
    } finally {
      routing.resolve({ config: DEFAULT_LINEAR_ROUTING_CONFIG, updatedAt });
    }

    expect((await work).canceled).toBe(1);
    expect(terminalRpc).toHaveBeenCalledOnce();
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
    expect(mocks.observations).toHaveBeenCalledWith("decoded:workspace-1", [
      "ISSUE-session-1",
      "ISSUE-session-2",
    ]);
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
      p_session_links: [linked("session-2")],
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
    let prefixStatus = "Todo";
    mocks.observations.mockImplementation(
      async (_key: string, ids: string[]) =>
        new Map(ids.map((id) => [id, { ...observation, statusName: prefixStatus }])),
    );

    await reconcileLinearState(admin as never);
    prefixStatus = "In Review";
    await reconcileLinearState(admin as never);

    const prefix = rpc.mock.calls.filter(([, args]) => args.p_session_id === "session-000");
    expect(prefix.map(([, args]) => args.p_status_name)).toEqual(["Todo", "In Review"]);
    expect(mocks.observations).toHaveBeenCalledTimes(6);
    expect(commitPage).toHaveBeenCalledTimes(2);
    for (const [page] of commitPage.mock.calls) {
      expect(page).toMatchObject({
        p_expected_generation: 7,
        p_session_links: [linked("session-050")],
      });
    }
  });

  it.each(["Canceled", "Done"])(
    "retains and routes %s in one transaction without losing the link on failure",
    async (statusName) => {
      const { admin, commitPage, terminalRpc, rpc } = adminFor([session(), session("session-2")]);
      commitPage.mockResolvedValue({
        data: [],
        error: { code: "XX000", message: "write unavailable" },
      });
      terminalRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "terminal span write unavailable" },
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

      expect((await reconcileLinearState(admin as never)).canceled).toBe(0);
      expect(rpc).toHaveBeenCalledExactlyOnceWith(
        "apply_linear_session_transition",
        expect.objectContaining({ p_session_id: "session-2" }),
      );
      expect(terminalRpc).toHaveBeenCalledExactlyOnceWith(
        "apply_terminal_linear_session_transition",
        expect.objectContaining({
          p_workspace_id: "workspace-1",
          p_expected_session_updated_at: updatedAt,
          p_expected_routing_updated_at: updatedAt,
          p_status_name: statusName,
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
        }),
      );

      rpc.mockClear();
      expect((await reconcileLinearState(admin as never)).canceled).toBe(1);
      expect(terminalRpc).toHaveBeenCalledTimes(2);
      expect(rpc).toHaveBeenCalledExactlyOnceWith(
        "apply_linear_session_transition",
        expect.objectContaining({ p_session_id: "session-2" }),
      );
    },
  );

  it("does not archive or clean up when the canonical terminal span is stale", async () => {
    const { admin, rpc, terminalRpc } = adminFor();
    terminalRpc.mockResolvedValue({
      data: [{ outcome: "stale", job_ids: [], run_ids: [] }],
      error: null,
    });
    mocks.observations.mockResolvedValue(
      new Map([["ISSUE-session-1", { ...observation, statusName: "Canceled" }]]),
    );

    expect((await reconcileLinearState(admin as never)).canceled).toBe(0);
    expect(terminalRpc).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    { firstStatus: "Canceled", latestStatus: "Todo" },
    { firstStatus: "Canceled", latestStatus: null },
    { firstStatus: "Rework", latestStatus: "In Review" },
  ])(
    "routes only a fresh lifecycle read after automation observed $firstStatus and the latest is $latestStatus",
    async ({ firstStatus, latestStatus }) => {
      const { admin, readCursor, commitPage, terminalRpc, rpc } = adminFor(
        Array.from({ length: 51 }, (_, index) =>
          session(`session-${String(index).padStart(3, "0")}`),
        ),
      );
      readCursor.mockResolvedValue({
        data: [{ after_session_id: "session-049", generation: 7 }],
        error: null,
      });
      const lastIssue = "ISSUE-session-050";
      let lastIssueReads = 0;
      mocks.observations.mockImplementation(async (_key: string, ids: string[]) => {
        if (!ids.includes(lastIssue)) return new Map(ids.map((id) => [id, observation]));
        if (++lastIssueReads === 1) {
          return new Map([
            [lastIssue, { ...observation, spanId: "earlier", statusName: firstStatus }],
          ]);
        }
        if (latestStatus === null) throw new LinearRateLimitedError();
        return new Map([
          [lastIssue, { ...observation, spanId: "latest", statusName: latestStatus }],
        ]);
      });

      const result = await reconcileLinearState(admin as never);

      expect(lastIssueReads).toBe(2);
      expect(result.rateLimited).toBe(latestStatus === null);
      expect(terminalRpc).not.toHaveBeenCalled();
      expect(commitPage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          p_session_links: [linked("session-050")],
          p_observations: [expect.objectContaining({ spanId: "earlier" })],
        }),
      );
      const routed = rpc.mock.calls.filter(([, input]) => input.p_session_id === "session-050");
      if (latestStatus !== null) {
        expect(routed).toEqual([
          [
            "apply_linear_session_transition",
            expect.objectContaining({
              p_source_span_id: "latest",
              p_status_name: latestStatus,
            }),
          ],
        ]);
      } else {
        expect(routed).toHaveLength(0);
      }
    },
  );

  it("advances a healthy later automation page after a lifecycle-only observation failure", async () => {
    const { admin, readCursor, commitPage, rpc } = adminFor([session(), session("session-2")]);
    readCursor.mockResolvedValue({
      data: [{ after_session_id: "session-1", generation: 6 }],
      error: null,
    });
    mocks.observations.mockImplementation(async (_key: string, ids: string[]) => {
      if (ids.includes("ISSUE-session-1")) throw new Error("incomplete lifecycle issue history");
      return new Map(ids.map((id) => [id, observation]));
    });

    await reconcileLinearState(admin as never);

    expect(rpc).not.toHaveBeenCalled();
    expect(commitPage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        p_workspace_id: "workspace-1",
        p_expected_generation: 6,
        p_session_links: [linked("session-2")],
        p_observations: [expect.objectContaining({ sessionId: "session-2" })],
      }),
    );
  });

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

    expect(mocks.observations).toHaveBeenCalledTimes(6);
    expect(commitPage).toHaveBeenCalledTimes(2);
    for (const [page] of commitPage.mock.calls) {
      expect(page).toMatchObject({
        p_expected_generation: 7,
        p_session_links: [linked("session-2")],
        p_workspace_id: "workspace-2",
        p_observations: [expect.objectContaining({ sessionId: "session-2" })],
      });
    }
    expect(readCursor.mock.calls.map(([, input]) => input.p_workspace_id).sort()).toEqual([
      "workspace-1",
      "workspace-1",
      "workspace-2",
      "workspace-2",
    ]);
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

    expect(mocks.observations).toHaveBeenCalledExactlyOnceWith("decoded:valid-fixture", [
      "ISSUE-session-2",
    ]);
    expect(commitPage.mock.calls.map(([page]) => page.p_workspace_id).sort()).toEqual([
      "workspace-2",
      "workspace-3",
    ]);
    expect(
      commitPage.mock.calls.find(([page]) => page.p_workspace_id === "workspace-3")?.[0],
    ).toMatchObject({
      p_observations: [],
      p_session_links: [linked("session-3")],
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[reconciler] failed to decrypt Linear API key",
      { workspaceId: "workspace-1" },
    );
  });

  it("routes and commits healthy workspaces while another is still waiting on throttling", async () => {
    const retry = Promise.withResolvers<void>();
    mocks.observations.mockImplementation(async (key: string, ids: string[]) => {
      if (key === "decoded:workspace-2") {
        await retry.promise;
        throw new LinearRateLimitedError();
      }
      return new Map(ids.map((id) => [id, observation]));
    });
    const { admin, rpc, commitPage } = adminFor([
      session(),
      session("session-2", "workspace-2"),
      session("session-3", "workspace-3"),
    ]);

    const work = reconcileLinearState(admin as never);
    try {
      await vi.waitFor(() => {
        expect(mocks.observations).toHaveBeenCalledWith("decoded:workspace-2", ["ISSUE-session-2"]);
        expect(commitPage.mock.calls.map(([page]) => page.p_workspace_id).sort()).toEqual([
          "workspace-1",
          "workspace-3",
        ]);
        expect(rpc.mock.calls.map(([, input]) => input.p_session_id).sort()).toEqual([
          "session-1",
          "session-3",
        ]);
      });
    } finally {
      retry.resolve();
    }
    expect((await work).rateLimited).toBe(true);
    expect(commitPage).toHaveBeenCalledTimes(2);
  });
  it("routes later lifecycle pages while the current workspace's automation cursor waits on Linear", async () => {
    const rows = [
      ...Array.from({ length: 51 }, (_, index) =>
        session(`session-${String(index).padStart(3, "0")}`),
      ),
      session("session-051", "workspace-2"),
    ];
    const { admin, readCursor, rpc, commitPage } = adminFor(rows);
    readCursor.mockImplementation(async (_, input) => ({
      data: [
        input.p_workspace_id === "workspace-1"
          ? { after_session_id: "session-049", generation: 7 }
          : { after_session_id: null, generation: 3 },
      ],
      error: null,
    }));
    const retry = Promise.withResolvers<void>();
    mocks.observations.mockImplementation(async (_key: string, ids: string[]) => {
      if (ids.includes("ISSUE-session-050")) {
        await retry.promise;
        throw new LinearRateLimitedError();
      }
      return new Map(ids.map((id) => [id, observation]));
    });

    const work = reconcileLinearState(admin as never);
    try {
      await vi.waitFor(() => {
        expect(mocks.observations).toHaveBeenCalledWith("decoded:workspace-1", [
          "ISSUE-session-050",
        ]);
        expect(rpc).toHaveBeenCalledWith(
          "apply_linear_session_transition",
          expect.objectContaining({ p_session_id: "session-051" }),
        );
        expect(commitPage).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ p_workspace_id: "workspace-2", p_expected_generation: 3 }),
        );
      });
    } finally {
      retry.resolve();
    }

    expect((await work).rateLimited).toBe(true);
    expect(commitPage).toHaveBeenCalledTimes(1);
  });

  it("skips the offset provider request when lifecycle throttles the workspace during its page read", async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      session(`session-${String(index).padStart(3, "0")}`),
    );
    const offsetRead = Promise.withResolvers<void>();
    const offsetStarted = Promise.withResolvers<void>();
    const { admin, readCursor, commitPage } = adminFor(rows, undefined, (table, filters) => {
      if (table === "sessions" && filters.workspace_id && filters["gt.id"] === "session-049") {
        offsetStarted.resolve();
        return offsetRead.promise;
      }
    });
    readCursor.mockResolvedValue({
      data: [{ after_session_id: "session-049", generation: 7 }],
      error: null,
    });
    mocks.observations.mockImplementation(async (_key: string, ids: string[]) => {
      if (ids.includes("ISSUE-session-050")) {
        await offsetStarted.promise;
        throw new LinearRateLimitedError();
      }
      return new Map(ids.map((id) => [id, observation]));
    });

    const work = reconcileLinearState(admin as never);
    try {
      await vi.waitFor(() =>
        expect(mocks.observations).toHaveBeenCalledWith("decoded:workspace-1", [
          "ISSUE-session-050",
        ]),
      );
    } finally {
      offsetRead.resolve();
    }

    expect((await work).rateLimited).toBe(true);
    expect(
      mocks.observations.mock.calls.filter(([, ids]) => ids.includes("ISSUE-session-050")),
    ).toHaveLength(1);
    expect(commitPage).not.toHaveBeenCalled();
  });

  it("defers a first HTTP 429 across the workspace while the next lifecycle page keeps moving", async () => {
    const rows = [
      ...Array.from({ length: 51 }, (_, index) =>
        session(`session-${String(index).padStart(3, "0")}`),
      ),
      session("session-051", "workspace-2"),
    ];
    const laterLifecyclePage = Promise.withResolvers<void>();
    const { admin, readCursor, rpc, commitPage } = adminFor(rows, undefined, (table, filters) => {
      if (table === "sessions" && !filters.workspace_id && filters["gt.id"] === "session-049") {
        return laterLifecyclePage.promise;
      }
    });
    readCursor.mockImplementation(async (_, input) => ({
      data: [
        input.p_workspace_id === "workspace-1"
          ? { after_session_id: "session-049", generation: 7 }
          : { after_session_id: null, generation: 3 },
      ],
      error: null,
    }));
    const actual = await vi.importActual<typeof import("@/lib/linear-routing/observations")>(
      "@/lib/linear-routing/observations",
    );
    const provider = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response("", { status: 429, headers: { "Retry-After": "30" } }),
      );
    const retry = Promise.withResolvers<void>();
    mocks.observations.mockImplementation(
      (key: string, ids: string[], sleep?: () => Promise<void>) =>
        ids.includes("ISSUE-session-050")
          ? actual.fetchLinearStateObservations(key, ids, sleep ? () => retry.promise : undefined)
          : Promise.resolve(new Map(ids.map((id) => [id, observation]))),
    );

    const work = reconcileLinearState(admin as never);
    try {
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
      laterLifecyclePage.resolve();
      await vi.waitFor(() => {
        expect(rpc).toHaveBeenCalledWith(
          "apply_linear_session_transition",
          expect.objectContaining({ p_session_id: "session-051" }),
        );
        expect(commitPage).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ p_workspace_id: "workspace-2", p_expected_generation: 3 }),
        );
      });
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      laterLifecyclePage.resolve();
      retry.resolve();
      await work;
      provider.mockRestore();
    }

    expect((await work).rateLimited).toBe(true);
  });

  it("excludes empty legacy links from provider reads and the exact cursor page", async () => {
    const { admin, commitPage, rpc } = adminFor([
      { ...session("session-0"), linear_issue_id: "" },
      session("session-1"),
    ]);

    expect((await reconcileLinearState(admin as never)).checked).toBe(1);

    expect(mocks.observations).toHaveBeenCalledExactlyOnceWith("decoded:workspace-1", [
      "ISSUE-session-1",
    ]);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "apply_linear_session_transition",
      expect.objectContaining({ p_session_id: "session-1" }),
    );
    expect(commitPage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ p_session_links: [linked("session-1")] }),
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
    expect(
      reads.filter((read) => read.table === "sessions" && !read.filters.workspace_id)[1]?.filters,
    ).toMatchObject({
      order: "id",
      "gt.id": "session-049",
    });
  });
});
