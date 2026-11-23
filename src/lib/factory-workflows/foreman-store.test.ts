import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import type { WorkflowOccurrencePin } from "./deterministic-command";
import { executeFactoryWorkflowOccurrence } from "./execute";
import { createOpenAiForemanProvider } from "./foreman-openai";
import { executeFactoryWorkflowForeman } from "./foreman-store";

const id = (suffix: number) => `b1000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const rootId = id(1);
const workspaceId = id(2);
const factoryId = id(3);
const occurrenceId = id(4);
const promptId = id(5);
const foremanRunId = id(6);
const issueId = id(7);
const decisionId = id(8);
const transitionId = id(9);
const targetOccurrenceId = id(10);
const childSessionId = id(11);
const childJobId = id(12);
const childRunId = id(13);
const checkpointId = id(14);
const ownerToken = id(15);
const model = "gpt-5.4-mini-2026-03-17";
const apiKey = "sk-proj-foreman_adapter_fixture_scope";
const environment = { WALLIE_ENCRYPTION_KEY: "adapter-local-fixture-encryption-key" };
const prompt = "Provide a decision for the approved workflow route.";
const destinationNodeId = "implement";
const readScope = {
  p_root_session_id: rootId,
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_route_occurrence_id: occurrenceId,
};
const usage = { inputTokens: 301, outputTokens: 76, costUsd: 0.00056775 };

const route = {
  kind: "route",
  decision: { kind: "choose", destinationNodeId, confidence: 0.95, reason: "In scoped work." },
} as const;
const delegate = {
  kind: "delegate",
  targetNodeId: destinationNodeId,
  title: "Implement the work",
  promptMd: "Keep the child source isolated.",
} as const;
const planJson = JSON.stringify({ version: 1, commands: [route, delegate] });
const routeReceipt = {
  ordinal: 1,
  kind: "route",
  status: "accepted",
  decisionId,
  resolution: "selected",
  transitionId,
  targetOccurrenceId,
} as const;
const delegateReceipt = {
  ordinal: 2,
  kind: "delegate",
  status: "accepted",
  decisionId,
  targetOccurrenceId,
  childSessionId,
  jobId: childJobId,
  runId: childRunId,
} as const;

function fixture(hasProfile = true) {
  const graph = {
    schemaVersion: 1,
    kind: "graph",
    entryNodeId: "route",
    nodes: [
      { id: "route", kind: "route", agentPromptRevisionId: promptId },
      { id: destinationNodeId, kind: "deterministic", operation: "checkpoint" },
      { id: "fallback", kind: "deterministic", operation: "checkpoint" },
    ],
    edges: [
      { id: "choose", kind: "route", from: "route", to: destinationNodeId },
      { id: "fallback", kind: "route", from: "route", to: "fallback" },
    ],
    grants: [],
    routePolicy: {
      maxNodeVisits: 3,
      maxLoopTraversals: 0,
      nodes: {
        route: {
          minimumConfidence: 0.5,
          allowedDestinationIds: [destinationNodeId],
          fallback: { kind: "route", destinationId: "fallback" },
          ...(hasProfile
            ? { foremanProfile: { definitionRevisionId: id(16), definitionDigest: "9".repeat(64) } }
            : {}),
        },
      },
    },
  };
  const graphJson = JSON.stringify(graph);
  const pin: WorkflowOccurrencePin = {
    p_root_session_id: rootId,
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_expected_generation: 7,
    p_ownership_token: ownerToken,
    occurrenceId,
    nodeId: "route",
    workflowDigest: sha(graphJson),
  };
  const now = Date.now();
  const issuedAt = new Date(now).toISOString().replace("Z", "+00:00");
  const deadlineAt = new Date(now + 15_000).toISOString().replace("Z", "+00:00");
  const identity = {
    foremanRunId,
    rootSessionId: rootId,
    workspaceId,
    factoryId,
    routeOccurrenceId: occurrenceId,
    routeNodeId: pin.nodeId,
    workflowDigest: pin.workflowDigest,
    parentSessionId: rootId,
    sourceCheckpointRunId: checkpointId,
    deadlineAt,
  };
  const issued = {
    ...identity,
    status: "issued",
    issueId,
    executionGeneration: 7,
    model,
    promptRevisionId: promptId,
    promptSha256: sha(prompt),
    promptMd: prompt,
    encryptedCredential: encryptSecretValue(apiKey, environment),
    reservedTokens: 5000,
    reservedCostUsd: 0.2,
    maxInputBytes: 49_152,
    maxOutputTokens: 4096,
    title: "Frozen root task",
    taskPromptMd: "Implement the scoped task.",
    allowedDestinationIds: [destinationNodeId],
    offeredChildren: [],
  };
  const accepted = {
    ...identity,
    status: "accepted",
    issuedGeneration: 7,
    currentGeneration: 7,
    issuedAt,
    settledAt: issuedAt,
    usage,
    providerReceiptId: "resp_foreman_store",
    planJson,
    planDigest: sha(planJson),
    commands: [
      { command: route, ordinal: 1 },
      { command: delegate, ordinal: 2 },
    ],
  };
  const snapshot = {
    execution: {
      root_session_id: rootId,
      workspace_id: workspaceId,
      factory_id: factoryId,
      graph_revision_id: id(17),
      graph_input_run_id: checkpointId,
      workflow_json: graphJson,
      workflow_digest: pin.workflowDigest,
      generation: pin.p_expected_generation,
    },
    occurrences: [{ occurrence_id: occurrenceId, node_id: pin.nodeId, is_entry: true }],
    results: [],
  };
  return { pin, issued, accepted, snapshot };
}

type RpcCall = { name: string; body: unknown };
type Reply = { name: string; data: unknown; status?: number };

function adminFixture(replies: Reply[]) {
  const calls: RpcCall[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const name = url.pathname.split("/").at(-1) ?? "";
    calls.push({ name, body: JSON.parse(String(init?.body)) });
    const next = replies.shift();
    if (!next || next.name !== name)
      return Response.json({ code: "XX000", message: "Unexpected RPC." }, { status: 500 });
    return Response.json(next.data, { status: next.status ?? 200 });
  };
  const admin = createClient<Database>("https://foreman.test", "fixture-service-key", {
    global: { fetch: mockFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { admin, calls, replies };
}

const read = "read_factory_workflow_foreman_run";
const begin = "begin_factory_workflow_foreman_inference";
const settle = "settle_factory_workflow_foreman_inference";
const dispatch = "dispatch_factory_workflow_foreman_command";
const workflow = "read_factory_workflow_execution";
const readRoute = "read_factory_workflow_route_decision";
const genericRoute = {
  decision_id: decisionId,
  resolution: "selected",
  transition_id: transitionId,
  target_occurrence_id: targetOccurrenceId,
};
const ordinaryRouteProgress = {
  status: "route_decided",
  decisionId,
  resolution: "selected",
  transitionId,
  targetOccurrenceId,
};

it("uses one fresh issued transport, settles exact usage and dispatches the stored plan in order", async () => {
  const { pin, issued, accepted } = fixture();
  const { admin, calls, replies } = adminFixture([
    { name: read, data: null },
    { name: begin, data: issued },
    { name: settle, data: accepted },
    { name: read, data: accepted },
    { name: dispatch, data: routeReceipt },
    { name: dispatch, data: delegateReceipt },
  ]);
  const openAiFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ object: "response.input_tokens", input_tokens: 301 }))
    .mockResolvedValueOnce(
      Response.json({
        object: "response",
        id: accepted.providerReceiptId,
        model,
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: planJson }],
          },
        ],
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: 377,
        },
      }),
    );
  const bindProvider = vi.fn((options: Parameters<typeof createOpenAiForemanProvider>[0]) =>
    createOpenAiForemanProvider({
      ...options,
      fetcher: openAiFetch,
      decrypt: (ciphertext) => decryptSecretValue(ciphertext, environment),
    }),
  );

  const progress = await executeFactoryWorkflowForeman(admin, pin, { bindProvider });
  expect(progress).toEqual({
    status: "completed",
    foremanRunId,
    usage,
    receipts: [
      { ...routeReceipt, foremanRunId },
      { ...delegateReceipt, foremanRunId },
    ],
  });
  expect(replies).toEqual([]);
  expect(bindProvider).toHaveBeenCalledOnce();
  expect(openAiFetch).toHaveBeenCalledTimes(2);
  const ownerScope = { ...readScope, p_expected_generation: 7, p_ownership_token: ownerToken };
  expect(calls).toEqual([
    { name: read, body: readScope },
    { name: begin, body: ownerScope },
    {
      name: settle,
      body: {
        ...ownerScope,
        p_issue_id: issueId,
        p_outcome: {
          status: "accepted",
          planJson,
          planDigest: sha(planJson),
          usage,
          providerReceiptId: accepted.providerReceiptId,
        },
      },
    },
    { name: read, body: readScope },
    { name: dispatch, body: { ...ownerScope, p_foreman_run_id: foremanRunId, p_ordinal: 1 } },
    { name: dispatch, body: { ...ownerScope, p_foreman_run_id: foremanRunId, p_ordinal: 2 } },
  ]);
  const publicProgress = JSON.stringify(progress);
  for (const privateValue of [issued.encryptedCredential, apiKey, ownerToken, issueId, planJson]) {
    expect(publicProgress).not.toContain(privateValue);
  }
});

it("keeps the generic decision and resumes only its remaining authorized foreman command despite exhaustion", async () => {
  const { pin, snapshot, accepted } = fixture();
  const { admin, calls } = adminFixture([
    {
      name: workflow,
      data: {
        ...snapshot,
        execution: {
          ...snapshot.execution,
          graph_route_blocker: "execution_budget_exhausted",
          graph_visit_limit_exhausted: true,
        },
      },
    },
    { name: readRoute, data: genericRoute },
    {
      name: read,
      data: {
        ...accepted,
        issuedGeneration: 6,
        commands: [{ command: route, ordinal: 1, receipt: routeReceipt }, accepted.commands[1]],
      },
    },
    { name: dispatch, data: delegateReceipt },
  ]);

  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual({
    ...ordinaryRouteProgress,
    foreman: {
      status: "completed",
      foremanRunId,
      usage,
      receipts: [
        { ...routeReceipt, foremanRunId },
        { ...delegateReceipt, foremanRunId },
      ],
    },
  });
  expect(calls.map((call) => call.name)).toEqual([workflow, readRoute, read, dispatch]);
  expect(calls.at(-1)?.body).toEqual({
    ...readScope,
    p_expected_generation: 7,
    p_ownership_token: ownerToken,
    p_foreman_run_id: foremanRunId,
    p_ordinal: 2,
  });
});

it("does not reopen completed commands or issue again on replay", async () => {
  const { pin, accepted } = fixture();
  const { admin, calls } = adminFixture([
    {
      name: read,
      data: {
        ...accepted,
        commands: [
          { command: route, ordinal: 1, receipt: routeReceipt },
          { command: delegate, ordinal: 2, receipt: delegateReceipt },
        ],
      },
    },
  ]);
  const bindProvider = vi.fn<typeof createOpenAiForemanProvider>();
  await expect(executeFactoryWorkflowForeman(admin, pin, { bindProvider })).resolves.toMatchObject({
    status: "completed",
    foremanRunId,
    receipts: [expect.objectContaining(routeReceipt), expect.objectContaining(delegateReceipt)],
  });
  expect(calls).toEqual([{ name: read, body: readScope }]);
  expect(bindProvider).not.toHaveBeenCalled();
});

it("keeps ordinary routes on their existing decision and proposal paths", async () => {
  const { pin, snapshot } = fixture(false);
  const { admin, calls } = adminFixture([
    { name: workflow, data: snapshot },
    { name: readRoute, data: genericRoute },
    { name: workflow, data: snapshot },
    { name: readRoute, data: null },
  ]);
  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual(
    ordinaryRouteProgress,
  );
  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual({
    status: "pending",
    code: "route_proposal_required",
  });
  expect(calls.map((call) => call.name)).toEqual([workflow, readRoute, workflow, readRoute]);
});

it("blocks a fresh issuance at the visit cap and preserves a route decided outside a foreman run", async () => {
  const { pin, snapshot } = fixture();
  const exhaustedSnapshot = {
    ...snapshot,
    execution: { ...snapshot.execution, graph_visit_limit_exhausted: true },
  };
  const { admin, calls } = adminFixture([
    { name: workflow, data: exhaustedSnapshot },
    { name: readRoute, data: null },
    { name: read, data: null },
    { name: workflow, data: exhaustedSnapshot },
    { name: readRoute, data: genericRoute },
    { name: read, data: null },
  ]);
  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual({
    status: "foreman",
    foreman: { status: "blocked", code: "workflow_visit_limit_exhausted" },
  });
  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual(
    ordinaryRouteProgress,
  );
  expect(calls.map((call) => call.name)).toEqual([
    workflow,
    readRoute,
    read,
    workflow,
    readRoute,
    read,
  ]);
});

it("rejects malformed or foreign projections before new issuance or command effects", async () => {
  const { pin, accepted } = fixture();
  const { admin, calls } = adminFixture([
    { name: read, data: { ...accepted, rootSessionId: id(20) } },
    { name: read, data: { ...accepted, encryptedCredential: "unexpected projection field" } },
    {
      name: read,
      data: {
        ...accepted,
        commands: [
          {
            command: { ...route, decision: { ...route.decision, reason: "Different plan" } },
            ordinal: 1,
          },
          accepted.commands[1],
        ],
      },
    },
  ]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(executeFactoryWorkflowForeman(admin, pin)).resolves.toEqual({
      status: "unavailable",
    });
  }
  expect(calls).toEqual(Array.from({ length: 3 }, () => ({ name: read, body: readScope })));
});

it("requests no mutation when the native read reports a newer workflow owner", async () => {
  const { pin, accepted } = fixture();
  const { admin, calls } = adminFixture([
    { name: read, data: { ...accepted, currentGeneration: 8 } },
  ]);
  await expect(executeFactoryWorkflowForeman(admin, pin)).resolves.toMatchObject({
    status: "stale",
    currentGeneration: 8,
    foremanRunId,
  });
  expect(calls).toEqual([{ name: read, body: readScope }]);
});

it("recovers a committed settlement with a lost RPC response without invoking the provider again", async () => {
  const { pin, issued, accepted } = fixture();
  const { admin, calls } = adminFixture([
    { name: read, data: null },
    { name: begin, data: issued },
    {
      name: settle,
      data: { code: "XX000", message: "Settlement response lost." },
      status: 503,
    },
    { name: settle, data: accepted },
    { name: read, data: accepted },
    { name: dispatch, data: routeReceipt },
    { name: dispatch, data: delegateReceipt },
  ]);
  const invoke = vi.fn().mockResolvedValue({ status: "completed", output: planJson, usage });
  const bindProvider = vi.fn<typeof createOpenAiForemanProvider>().mockReturnValue(invoke);

  await expect(executeFactoryWorkflowForeman(admin, pin, { bindProvider })).resolves.toMatchObject({
    status: "completed",
    foremanRunId,
  });
  expect(invoke).toHaveBeenCalledOnce();
  expect(calls.map((call) => call.name)).toEqual([
    read,
    begin,
    settle,
    settle,
    read,
    dispatch,
    dispatch,
  ]);
  expect(calls[2]).toEqual(calls[3]);
});

it("accepts an existing native issuance only as a retained run with receipts", async () => {
  const { pin, accepted } = fixture();
  const retained = {
    ...accepted,
    commands: [
      { command: route, ordinal: 1, receipt: routeReceipt },
      { command: delegate, ordinal: 2, receipt: delegateReceipt },
    ],
  };
  const { admin, calls } = adminFixture([
    { name: read, data: null },
    { name: begin, data: { status: "existing", run: retained } },
    { name: read, data: retained },
  ]);
  const bindProvider = vi.fn<typeof createOpenAiForemanProvider>();
  await expect(executeFactoryWorkflowForeman(admin, pin, { bindProvider })).resolves.toMatchObject({
    status: "completed",
    foremanRunId,
  });
  expect(bindProvider).not.toHaveBeenCalled();
  expect(calls.map((call) => call.name)).toEqual([read, begin, read]);
});
