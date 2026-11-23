import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import { mutateWorkflowAuthoring } from "./authoring";
import type { WorkflowAuthoringCommand, WorkflowAuthoringSnapshot } from "./authoring-contracts";

function id(value: number) {
  return `65540000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

it.each(["save", "publish"] as const)(
  "recovers %s before reading live graph references",
  async (action) => {
    const scope = { workspaceId: id(1), factoryId: id(2), workflowId: id(3), actorUserId: id(4) };
    const digest = "a".repeat(64);
    const baseDefinition = { activationId: id(5), revisionId: id(6), digest };
    const graph = workflowGraphSchema.parse({
      schemaVersion: 1,
      kind: "graph",
      entryNodeId: "review",
      nodes: [
        { id: "review", kind: "human-gate", anyoneCanApprove: false, approverMemberIds: [id(7)] },
      ],
      edges: [],
      grants: [],
    });
    const draftId = id(8);
    const expected = { baseDefinition, draftId, activationId: null };
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
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const resource = new URL(String(input)).pathname.split("/").at(-1);
      if (resource === "read_factory_workflow_authoring") {
        requests.push(resource);
        return Response.json(snapshot);
      }
      if (resource === "find_factory_workflow_authoring_receipt") {
        requests.push(resource);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          p_request_id: command.requestId,
          p_actor_user_id: scope.actorUserId,
          p_action: action,
          p_request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        return Response.json(receipt);
      }
      throw new Error("The live reference should not be read while replaying a receipt.");
    });
    const client = createClient<Database>("http://127.0.0.1:1", "fixture-key", {
      global: { fetch },
    });
    await expect(mutateWorkflowAuthoring(client, () => client, scope, command)).resolves.toEqual({
      ok: true,
      action,
      receipt,
    });
    expect(requests).toEqual([
      "read_factory_workflow_authoring",
      "find_factory_workflow_authoring_receipt",
    ]);
  },
);
