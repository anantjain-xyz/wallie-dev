// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type {
  WorkflowAuthoringSnapshot,
  WorkflowEditorCatalog,
} from "@/lib/factory-workflows/authoring-contracts";

import { WorkflowEditor } from "./workflow-editor";

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

function openEditor() {
  return render(
    <WorkflowEditor
      initial={initial}
      choices={choices}
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
