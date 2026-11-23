import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/factories/route-context", () => ({
  factoryResponseHeaders: { "Cache-Control": "private, no-store" },
  resolveFactoryRouteContext: mocks.context,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));

import { GET, POST } from "./route";

function id(suffix: number) {
  return `66510000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

const scope = { workspaceId: id(1), factoryId: id(2) };
const params = Promise.resolve(scope);
const actor = {
  p_workspace_id: scope.workspaceId,
  p_factory_id: scope.factoryId,
  p_actor_user_id: id(3),
};
const candidate = {
  sessionId: id(4),
  checkpointRunId: id(5),
  approvalId: id(6),
  policyRevisionId: id(7),
  mergeObservationId: id(8),
  deploymentSourceId: id(9),
  repositoryId: id(10),
  approvedHeadSha: "a".repeat(40),
  sourceRevision: "b".repeat(40),
};
const {
  sessionId,
  checkpointRunId,
  approvalId,
  policyRevisionId,
  mergeObservationId,
  deploymentSourceId,
} = candidate;
const prepare = {
  action: "prepare",
  commandId: id(11),
  sessionId,
  checkpointRunId,
  approvalId,
  policyRevisionId,
  mergeObservationId,
  deploymentSourceId,
};
const command = {
  ...candidate,
  id: prepare.commandId,
  requestedByMemberId: id(12),
  requestedAt: "2026-11-23T16:00:00+00:00",
  dispatchStartedAt: null,
  dispatchState: "queued",
  outcome: null,
  deploymentObservationId: null,
};
const url = "https://wallie.example.test/api/delivery-commands";

function post(body: unknown) {
  return POST(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params },
  );
}

describe("guarded delivery command route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.context.mockResolvedValue({
      ...scope,
      ok: true,
      access: { user: { id: actor.p_actor_user_id } },
    });
  });

  it("returns a scoped candidate with both exact source SHAs", async () => {
    mocks.rpc.mockResolvedValue({ data: candidate, error: null });
    const response = await GET(
      new Request(`${url}?sessionId=${sessionId}&deploymentSourceId=${deploymentSourceId}`),
      { params },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ candidate });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("read_factory_delivery_command_candidate", {
      ...actor,
      p_session_id: sessionId,
      p_deployment_source_id: deploymentSourceId,
    });
  });

  it("submits the selected evidence and never accepts caller-supplied scope or outcome", async () => {
    mocks.rpc.mockResolvedValue({ data: command, error: null });
    const response = await post(prepare);
    expect(await response.json()).toEqual({ command });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("prepare_factory_delivery_command", {
      ...actor,
      p_command_id: prepare.commandId,
      p_session_id: sessionId,
      p_checkpoint_run_id: checkpointRunId,
      p_approval_id: approvalId,
      p_policy_revision_id: policyRevisionId,
      p_merge_observation_id: mergeObservationId,
      p_deployment_source_id: deploymentSourceId,
    });
    expect((await post({ ...prepare, outcome: "succeeded" })).status).toBe(400);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not access delivery commands for an inaccessible factory", async () => {
    mocks.context.mockResolvedValue({ ok: false, response: new Response(null, { status: 404 }) });
    expect((await post(prepare)).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["PT409", "55P03"])(
    "reports scoped authority conflict %s as a retryable HTTP conflict",
    async (code) => {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "private fixture" } });
      const response = await post(prepare);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Could not apply the delivery command." });
    },
  );

  it("reads and cancels only the named command", async () => {
    mocks.rpc.mockResolvedValue({ data: { ...command, dispatchState: "cancelled" }, error: null });
    expect((await post({ action: "cancel", commandId: command.id })).status).toBe(200);
    expect((await GET(new Request(`${url}?commandId=${command.id}`), { params })).status).toBe(200);
    expect(mocks.rpc.mock.calls).toEqual([
      ["cancel_factory_delivery_command", { ...actor, p_command_id: command.id }],
      ["read_factory_delivery_command", { ...actor, p_command_id: command.id }],
    ]);
  });
});

it("pins the manager's exact Actions target in the guarded prepare transaction", async () => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({
    ...scope,
    ok: true,
    access: { user: { id: actor.p_actor_user_id } },
  });
  const actions = {
    workflowId: 701,
    workflowPath: ".github/workflows/ship.yml",
    tag: "release/exact",
    inputs: { lane: "staging" },
  };
  const receipt = {
    ...command,
    actions: {
      workflowId: actions.workflowId,
      workflowPath: actions.workflowPath,
      tag: actions.tag,
      reason: "awaiting_dispatch",
      runId: null,
      runStatus: null,
      runConclusion: null,
    },
  };
  mocks.rpc.mockResolvedValue({ data: receipt, error: null });
  const response = await post({ ...prepare, actions });
  expect(await response.json()).toEqual({ command: receipt });
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
    "prepare_factory_actions_delivery_command",
    expect.objectContaining({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_merge_observation_id: mergeObservationId,
      p_deployment_source_id: deploymentSourceId,
      p_workflow_id: actions.workflowId,
      p_workflow_path: actions.workflowPath,
      p_tag: actions.tag,
      p_inputs: actions.inputs,
    }),
  );
  expect(
    (await post({ ...prepare, actions: { ...actions, inputs: { wallie_source_sha: "x" } } }))
      .status,
  ).toBe(400);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
