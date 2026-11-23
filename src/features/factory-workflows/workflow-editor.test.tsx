// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";
import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type {
  WorkflowAuthoringSnapshot,
  WorkflowEditorCatalog,
} from "@/lib/factory-workflows/authoring-contracts";

import { WorkflowEditor } from "./workflow-editor";
import { defaultDelegationPolicy } from "./editor-graph";

function id(value: number) {
  return `65520000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const digest = "a".repeat(64);
const endpoint = "/api/factory-workflow";
const missingPrompt = id(7);
const laterPrompt = { id: id(8), label: "Later revision" };
const promptCursor = { id: id(12), createdAt: "2026-11-22T23:00:00.000123+00:00" };
const baseDefinition = { activationId: id(1), revisionId: id(2), digest };
const initial: WorkflowAuthoringSnapshot = {
  workflowId: id(3),
  displayName: "Release",
  baseDefinition,
  draftBaseDefinition: baseDefinition,
  activationId: null,
  draftId: id(4),
  draftDigest: digest,
  graph: workflowGraphSchema.parse({
    schemaVersion: 1,
    kind: "graph",
    entryNodeId: "build",
    nodes: [{ id: "build", kind: "agent", agentPromptRevisionId: missingPrompt }],
    edges: [],
    grants: [],
  }),
  recentDrafts: [],
  publishedDraftId: null,
  publishedGraphRevisionId: null,
  selectedDraftId: null,
  selectedDraftGraph: null,
  selectedDraftDigest: null,
  selectedDraftBaseDefinition: null,
};
const choices: WorkflowEditorCatalog = {
  prompts: [],
  approvers: [],
  profiles: [],
  writers: [],
  grant: { id: id(5), version: 1 },
  nextCursors: { writers: null, prompts: promptCursor, approvers: null, profiles: null },
};

function openEditor(snapshot = initial, editorChoices = choices) {
  return render(
    <WorkflowEditor
      initial={snapshot}
      choices={editorChoices}
      workspaceSlug="acme"
      factoryId={id(6)}
      endpoint={endpoint}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps later choices on a same-base reload and preserves the saved missing prompt", async () => {
  const fetch = vi.fn(async (url: string) =>
    url.includes("includeChoices")
      ? Response.json({ snapshot: initial, choices })
      : Response.json({ catalog: "prompts", items: [laterPrompt], nextCursor: null }),
  );
  vi.stubGlobal("fetch", fetch);
  openEditor();

  const prompt = screen.getByRole("combobox", { name: "Agent prompt revision" });
  expect(prompt).toHaveAttribute("data-value", missingPrompt);
  fireEvent.click(screen.getByRole("button", { name: "Load more prompt revisions" }));
  await screen.findByText("More prompt revisions loaded.");
  const query = new URLSearchParams({
    catalog: "prompts",
    afterId: promptCursor.id,
    afterCreatedAt: promptCursor.createdAt,
  });
  expect(fetch).toHaveBeenCalledWith(`${endpoint}?${query}`, {
    cache: "no-store",
  });
  fireEvent.click(screen.getByRole("button", { name: "Load current draft" }));
  await screen.findByText("Current draft loaded.");
  expect(prompt).toHaveAttribute("data-value", missingPrompt);
  fireEvent.click(prompt);
  fireEvent.click(await screen.findByRole("option", { name: laterPrompt.label }));
  expect(prompt).toHaveAttribute("data-value", laterPrompt.id);
});

it("uses the new exact grant after loading a draft with a switched base activation", async () => {
  const nextGrant = { id: id(9), version: 2 };
  const nextBase = { activationId: id(10), revisionId: id(11), digest: "b".repeat(64) };
  const fetch = vi.fn(async () =>
    Response.json({
      snapshot: { ...initial, baseDefinition: nextBase, draftBaseDefinition: nextBase },
      choices: { ...choices, grant: nextGrant },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  openEditor();
  fireEvent.click(screen.getByText("Workflow policies"));
  expect(screen.getByLabelText("Use approved factory grant · Version 1")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Load current draft" }));
  await screen.findByText("Current draft loaded.");
  expect(fetch).toHaveBeenCalledWith(`${endpoint}?includeChoices=true`, { cache: "no-store" });
  expect(screen.queryByLabelText("Use approved factory grant · Version 1")).toBeNull();
  expect(screen.getByLabelText("Use approved factory grant · Version 2")).toBeInTheDocument();
});

it("rebases and publishes after removing the previous primary grant and retaining the secondary writer", async () => {
  const former = { id: id(13), version: 1 };
  const current = { id: id(14), version: 2 };
  const secondary = { id: id(15), version: 3 };
  const secondaryRepositoryId = id(16);
  const nextBase = { activationId: id(17), revisionId: id(18), digest: "b".repeat(64) };
  const nextDraft = id(19);
  const nextActivation = id(20);
  const profile = { definitionRevisionId: id(21), definitionDigest: digest };
  const graph = workflowGraphSchema.parse({
    schemaVersion: 1,
    kind: "graph",
    entryNodeId: "split",
    nodes: [
      { id: "split", kind: "branch" },
      { id: "primary", kind: "agent", agentPromptRevisionId: missingPrompt, grantId: former.id },
      { id: "docs", kind: "agent", agentPromptRevisionId: missingPrompt, grantId: secondary.id },
      { id: "join", kind: "join" },
      { id: "approve", kind: "human-gate", anyoneCanApprove: true, approverMemberIds: [] },
    ],
    edges: [
      { id: "main-work", from: "split", to: "primary", kind: "branch", required: true },
      { id: "docs-work", from: "split", to: "docs", kind: "branch", required: true },
      { id: "main-result", from: "primary", to: "join", kind: "branch-result" },
      { id: "docs-result", from: "docs", to: "join", kind: "branch-result" },
      { id: "approval", from: "join", to: "approve", kind: "next" },
    ],
    grants: [former, secondary],
    delegationPolicy: { ...defaultDelegationPolicy, targets: { primary: profile, docs: profile } },
    repositorySets: {
      join: [
        {
          repositoryId: secondaryRepositoryId,
          writerGrant: secondary,
          branchEdgeIds: ["docs-work"],
        },
      ],
    },
  });
  const original = { ...initial, graph };
  const switched = { ...original, baseDefinition: nextBase };
  const workspaceId = id(22);
  const compile = (value: unknown) =>
    compileWorkflowGraph(
      { kind: "structured", value },
      {
        workspaceId,
        agentPromptRevisions: [{ id: missingPrompt, workspaceId }],
        approvers: [],
        approvedGrants: [current, secondary].map((grant) => ({ ...grant, workspaceId })),
      },
    );
  expect(compile(graph)).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: "invalid_grant", path: ["grants", 0] })],
  });

  let saved: WorkflowAuthoringSnapshot | undefined;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("?includeChoices=true"))
      return Response.json({ snapshot: switched, choices: { ...choices, grant: current } });
    if (options?.method === "POST") {
      const command = JSON.parse(String(options.body));
      if (command.action === "save") {
        const repaired = {
          ...graph,
          grants: [current, secondary],
          nodes: graph.nodes.map((node) =>
            node.id === "primary" ? { ...node, grantId: undefined } : node,
          ),
        };
        expect(command).toMatchObject({
          rebase: true,
          expected: { draftId: original.draftId, baseDefinition: nextBase },
        });
        expect(command.graph).toEqual(JSON.parse(JSON.stringify(repaired)));
        const result = compile(command.graph);
        if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
        saved = {
          ...switched,
          graph: result.bundle,
          draftId: nextDraft,
          draftDigest: result.canonicalDigest,
          draftBaseDefinition: nextBase,
          selectedDraftId: nextDraft,
          selectedDraftGraph: result.bundle,
          selectedDraftDigest: result.canonicalDigest,
          selectedDraftBaseDefinition: nextBase,
        };
        return Response.json({
          action: "save",
          receipt: { draftId: nextDraft, digest: result.canonicalDigest, created: true },
        });
      }
      if (command.action === "publish" && saved) {
        expect(command.expected).toEqual({
          draftId: nextDraft,
          activationId: null,
          baseDefinition: nextBase,
        });
        const graphRevisionId = id(23);
        saved = {
          ...saved,
          activationId: nextActivation,
          publishedDraftId: nextDraft,
          publishedGraphRevisionId: graphRevisionId,
        };
        return Response.json({
          action: "publish",
          receipt: {
            draftId: nextDraft,
            digest: saved.draftDigest,
            created: true,
            activationId: nextActivation,
            graphRevisionId,
          },
        });
      }
    }
    if (saved && url === `${endpoint}?draftId=${nextDraft}`) return Response.json(saved);
    throw new Error(`Unexpected editor request for ${url}.`);
  });
  vi.stubGlobal("fetch", fetch);
  openEditor(original, { ...choices, grant: former });
  fireEvent.click(screen.getByText("Workflow policies"));
  const removeObsolete = "Remove obsolete factory grants";
  expect(screen.queryByRole("button", { name: removeObsolete })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Load current draft" }));
  await screen.findByText("Current draft loaded.");
  fireEvent.click(screen.getByRole("button", { name: removeObsolete }));
  expect(screen.queryByRole("button", { name: removeObsolete })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Use approved factory grant · Version 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Rebase and save draft" }));
  await screen.findByText("Draft saved.");

  fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
  await screen.findByText("Workflow published.");
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("focuses the same diagnostic again after selecting another step", async () => {
  const snapshot = {
    ...initial,
    graph: workflowGraphSchema.parse({
      schemaVersion: 1,
      kind: "graph",
      entryNodeId: "prepare",
      nodes: [
        { id: "prepare", kind: "deterministic", operation: "checkpoint" },
        { id: "verify", kind: "deterministic", operation: "policy" },
      ],
      edges: [{ id: "next", kind: "next", from: "prepare", to: "verify" }],
      grants: [],
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: "Resolve the workflow diagnostics.",
          diagnostics: [{ path: ["nodes", 1, "id"], message: "Check the second step." }],
        },
        { status: 422 },
      ),
    ),
  );
  render(
    <WorkflowEditor
      initial={snapshot}
      choices={choices}
      workspaceSlug="acme"
      factoryId={id(6)}
      endpoint={endpoint}
    />,
  );

  fireEvent.change(screen.getByRole("textbox", { name: "Step ID" }), {
    target: { value: "prepare-source" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const diagnostic = await screen.findByRole("button", { name: /Check the second step/ });
  expect(screen.getByRole("textbox", { name: "Step ID" })).toHaveValue("verify");

  const steps = screen.getByRole("region", { name: "Workflow steps" });
  fireEvent.click(within(steps).getByRole("button", { name: /prepare-source/ }));
  expect(screen.getByRole("textbox", { name: "Step ID" })).toHaveValue("prepare-source");
  fireEvent.click(diagnostic);
  const field = screen.getByRole("textbox", { name: "Step ID" });
  expect(field).toHaveValue("verify");
  expect(field).toHaveFocus();
});
