import { afterEach, expect, it, vi } from "vitest";

import type { WorkflowAuthoringCommand } from "@/lib/factory-workflows/authoring-contracts";

import { submitWorkflowAuthoringCommand } from "./authoring-client";

function id(value: number) {
  return `65540000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const endpoint = "/api/factory-workflow";
const workflowId = id(1);
const draftId = id(2);
const priorActivation = id(3);
const newActivation = id(4);
const laterActivation = id(5);
const digest = "a".repeat(64);
const baseDefinition = { activationId: id(6), revisionId: id(7), digest };
const graph = {
  schemaVersion: 1,
  kind: "graph",
  entryNodeId: "checkpoint",
  nodes: [{ id: "checkpoint", kind: "deterministic", operation: "checkpoint" }],
  edges: [],
  grants: [],
};

afterEach(() => vi.unstubAllGlobals());

it.each([
  { action: "save", expected: null, observed: null, moved: false },
  { action: "save", expected: null, observed: newActivation, moved: true },
  { action: "save", expected: priorActivation, observed: newActivation, moved: true },
  { action: "publish", expected: priorActivation, observed: newActivation, moved: false },
  { action: "publish", expected: priorActivation, observed: laterActivation, moved: true },
] as const)(
  "reconciles $action with activation $observed and an unchanged draft and base",
  async ({ action, expected, observed, moved }) => {
    const commandContext = {
      requestId: id(8),
      expected: { activationId: expected, draftId, baseDefinition },
    };
    const command: WorkflowAuthoringCommand =
      action === "save"
        ? { ...commandContext, action, graph, rebase: false }
        : { ...commandContext, action };
    const result = {
      action,
      receipt: {
        draftId,
        digest,
        created: true,
        ...(action === "publish" ? { activationId: newActivation, graphRevisionId: id(9) } : {}),
      },
    };
    const snapshot = {
      workflowId,
      displayName: "Release",
      activationId: observed,
      draftId,
      draftDigest: digest,
      baseDefinition,
      draftBaseDefinition: baseDefinition,
      graph,
      recentDrafts: [],
      publishedDraftId: observed ? draftId : null,
      publishedGraphRevisionId: observed ? id(9) : null,
      selectedDraftId: draftId,
      selectedDraftGraph: graph,
      selectedDraftDigest: digest,
      selectedDraftBaseDefinition: baseDefinition,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(Response.json(snapshot));
    vi.stubGlobal("fetch", fetch);

    await expect(submitWorkflowAuthoringCommand(endpoint, workflowId, command)).resolves.toEqual({
      result,
      snapshot,
      moved,
    });
  },
);
