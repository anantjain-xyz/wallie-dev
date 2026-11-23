import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import { mutateWorkflowAuthoring } from "./authoring";
import type { WorkflowAuthoringCommand, WorkflowAuthoringSnapshot } from "./authoring-contracts";

function id(value: number) {
  return `65540000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const definitionJson = JSON.stringify({
  schemaVersion: 1,
  kind: "serial",
  sandboxProvider: "vercel",
  pipelineId: id(15),
  repositoryId: id(16),
  executionPolicyRevisionId: id(17),
  deliveryPolicyRevisionId: null,
  operatingRulesMd: "",
  skillIds: [],
  toolIds: [],
  operatingRuleStageIds: [],
  agent: {
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    effort: "high",
    concurrencyLimit: 1,
    stallTimeoutMs: 90_000,
    maxRetries: 1,
    maxTurns: 12,
  },
  stages: [
    { id: id(18), slug: "plan", name: "Plan", anyoneCanApprove: true, previousStageIds: [] },
  ],
});
const scope = { workspaceId: id(1), factoryId: id(2), workflowId: id(3), actorUserId: id(4) };
const digest = createHash("sha256").update(definitionJson).digest("hex");
const baseDefinition = { activationId: id(5), revisionId: id(6), digest };
const graphInput = {
  schemaVersion: 1,
  kind: "graph",
  entryNodeId: "review",
  nodes: [
    { id: "review", kind: "human-gate", anyoneCanApprove: false, approverMemberIds: [id(7)] },
  ],
  edges: [],
  grants: [],
};
const graph = workflowGraphSchema.parse(graphInput);
const draftId = id(8);
const expected = { baseDefinition, draftId, activationId: null };
const receiptRequest = "find_factory_workflow_authoring_receipt";
const authorityRead = "read_factory_workflow_authoring";

function fixture(
  action: "save" | "publish",
  {
    compilation,
    recheck = "committed",
  }: {
    compilation?: "inactive" | "missing" | "throws";
    recheck?: "committed" | "miss" | "denied";
  } = {},
) {
  const command: WorkflowAuthoringCommand =
    action === "save"
      ? { action, requestId: id(9), expected, graph, rebase: false }
      : { action, requestId: id(9), expected };
  const savedReceipt = { draftId, digest, created: false };
  const receipt =
    action === "save"
      ? savedReceipt
      : { ...savedReceipt, activationId: id(10), graphRevisionId: id(11) };
  const snapshot: WorkflowAuthoringSnapshot = {
    workflowId: scope.workflowId,
    displayName: "Release",
    baseDefinition,
    draftId,
    activationId: id(10),
    draftDigest: digest,
    draftBaseDefinition: baseDefinition,
    graph,
    recentDrafts: [],
    publishedDraftId: draftId,
    publishedGraphRevisionId: id(11),
    selectedDraftId: action === "publish" ? draftId : null,
    selectedDraftGraph: action === "publish" ? graph : null,
    selectedDraftDigest: action === "publish" ? digest : null,
    selectedDraftBaseDefinition: action === "publish" ? baseDefinition : null,
  };
  const requests: string[] = [];
  const fingerprints: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const resource = new URL(String(input)).pathname.split("/").at(-1) ?? "";
    requests.push(resource);
    if (resource === authorityRead) return Response.json(snapshot);
    if (resource === receiptRequest) {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        p_request_id: command.requestId,
        p_actor_user_id: scope.actorUserId,
        p_action: action,
        p_request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      fingerprints.push(body.p_request_fingerprint);
      if (!compilation) return Response.json(receipt);
      if (fingerprints.length === 1 || recheck === "miss") return Response.json(null);
      return recheck === "denied"
        ? Response.json(
            { code: "42501", message: "Factory manager access is required." },
            { status: 403 },
          )
        : Response.json(receipt);
    }
    if (compilation && resource === "factory_definition_revisions") {
      if (compilation === "throws") {
        return Response.json(
          { code: "read_failed", message: "Could not read the base." },
          { status: 400 },
        );
      }
      return Response.json(compilation === "missing" ? [] : [{ definition_json: definitionJson }]);
    }
    if (compilation === "inactive" && resource === "workspace_members") return Response.json([]);
    throw new Error(`Unexpected authoring request: ${resource}`);
  });
  const client = createClient<Database>("http://127.0.0.1:1", "fixture-key", { global: { fetch } });
  return {
    command,
    invoke: (input = command) => mutateWorkflowAuthoring(client, () => client, scope, input),
    requests,
    fingerprints,
    result: { ok: true, action, receipt },
  };
}

it.each(["save", "publish"] as const)(
  "recovers %s before reading live graph references",
  async (action) => {
    const { invoke, requests, result } = fixture(action);
    await expect(invoke()).resolves.toEqual(result);
    expect(requests).toEqual([authorityRead, receiptRequest]);
  },
);

it("uses the same Save fingerprint only for the same command", async () => {
  const { command, invoke, fingerprints } = fixture("save");
  if (command.action !== "save") throw new Error("Expected a Save command.");
  await invoke();
  await invoke();
  await invoke({
    ...command,
    graph: {
      ...graphInput,
      nodes: [{ ...graphInput.nodes[0], approverMemberIds: [id(14)] }],
    },
  });
  expect(fingerprints).toHaveLength(3);
  expect(fingerprints[0]).toBe(fingerprints[1]);
  expect(fingerprints[0]).not.toBe(fingerprints[2]);
});

it.each([
  ["save", "inactive", ["factory_definition_revisions", "workspace_members"]],
  ["publish", "missing", ["factory_definition_revisions"]],
  ["publish", "throws", ["factory_definition_revisions"]],
] as const)(
  "recovers %s after a concurrent commit while compilation is %s",
  async (action, compilation, liveReads) => {
    const { invoke, requests, fingerprints, result } = fixture(action, { compilation });
    await expect(invoke()).resolves.toEqual(result);
    expect(requests).toEqual([authorityRead, receiptRequest, ...liveReads, receiptRequest]);
    expect(fingerprints).toEqual([fingerprints[0], fingerprints[0]]);
  },
);

it("preserves the live diagnostics when no exact receipt committed", async () => {
  const { invoke, fingerprints } = fixture("save", { compilation: "inactive", recheck: "miss" });
  await expect(invoke()).resolves.toMatchObject({ status: 422, diagnostics: expect.any(Array) });
  expect(fingerprints).toHaveLength(2);
});

it("preserves a thrown live-read failure when no exact receipt committed", async () => {
  const { invoke, fingerprints } = fixture("publish", { compilation: "throws", recheck: "miss" });
  await expect(invoke()).rejects.toMatchObject({ code: "read_failed" });
  expect(fingerprints).toHaveLength(2);
});

it("rejects receipt recovery after manager access was revoked", async () => {
  const { invoke, fingerprints } = fixture("save", { compilation: "inactive", recheck: "denied" });
  await expect(invoke()).rejects.toMatchObject({ code: "42501" });
  expect(fingerprints).toHaveLength(2);
});
