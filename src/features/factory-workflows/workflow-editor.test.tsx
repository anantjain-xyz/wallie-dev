// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";
import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type {
  WorkflowAuthoringSnapshot,
  WorkflowEditorCatalog,
} from "@/lib/factory-workflows/authoring-contracts";

import { WorkflowEditor } from "./workflow-editor";
import { defaultDelegationPolicy } from "./editor-graph";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

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

function openEditor(snapshot = initial, editorChoices = choices, recoveryOwner = id(31)) {
  return render(
    <PortalRootProvider>
      <WorkflowEditor
        initial={snapshot}
        choices={editorChoices}
        workspaceSlug="acme"
        factoryId={id(6)}
        endpoint={endpoint}
        recoveryOwner={recoveryOwner}
      />
    </PortalRootProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  router.push.mockClear();
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
  openEditor(snapshot);

  fireEvent.click(screen.getByText("Advanced step settings"));
  fireEvent.change(screen.getByRole("textbox", { name: "Step ID" }), {
    target: { value: "prepare-source" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const diagnostic = await screen.findByRole("button", { name: /Check the second step/ });
  expect(screen.getByRole("textbox", { name: "Step ID" })).toHaveValue("verify");

  const steps = screen.getByRole("region", { name: "Workflow steps" });
  fireEvent.click(within(steps).getByRole("button", { name: /Checkpoint/ }));
  fireEvent.click(screen.getByText("Advanced step settings"));
  expect(screen.getByRole("textbox", { name: "Step ID" })).toHaveValue("prepare-source");
  fireEvent.click(diagnostic);
  const field = screen.getByRole("textbox", { name: "Step ID" });
  expect(field).toHaveValue("verify");
  expect(field).toHaveFocus();
});

it("saves and publishes the product template with scoped roles and source-stage approval", async () => {
  const template = { id: "product-delivery", version: 1 } as const;
  const empty: WorkflowAuthoringSnapshot = {
    ...initial,
    template,
    graph: null,
    draftId: null,
    draftDigest: null,
    draftBaseDefinition: null,
  };
  const prompt = { id: id(31), label: "Configured writer prompt" };
  const reviewer = { id: id(32), label: "Review exact evidence" };
  const profile = { id: id(33), digest, label: "Activated role" };
  const approver = id(34);
  const draftId = id(35);
  const activationId = id(36);
  const graphRevisionId = id(37);
  let saved: WorkflowAuthoringSnapshot | undefined;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const command = JSON.parse(String(options.body));
      if (command.action === "save") {
        expect(command.expected).toEqual({ draftId: null, activationId: null, baseDefinition });
        const graph = workflowGraphSchema.parse(command.graph);
        expect(graph).toMatchObject({
          entryNodeId: "scope.approval",
          nodes: expect.arrayContaining([
            {
              id: "scope.approval",
              kind: "human-gate",
              anyoneCanApprove: false,
              approverMemberIds: [approver],
            },
            {
              id: "final.approval",
              kind: "human-gate",
              anyoneCanApprove: false,
              approverMemberIds: [approver],
            },
            expect.objectContaining({ kind: "route", agentPromptRevisionId: prompt.id }),
            expect.objectContaining({ kind: "review", reviewerPromptRevisionId: reviewer.id }),
          ]),
          routePolicy: {
            nodes: {
              "triage.route": {
                foremanProfile: {
                  definitionRevisionId: profile.id,
                  definitionDigest: profile.digest,
                },
              },
            },
          },
        });
        saved = {
          ...empty,
          graph,
          draftId,
          draftDigest: digest,
          draftBaseDefinition: baseDefinition,
          selectedDraftId: draftId,
          selectedDraftGraph: graph,
          selectedDraftDigest: digest,
          selectedDraftBaseDefinition: baseDefinition,
        };
        return Response.json({ action: "save", receipt: { draftId, digest, created: true } });
      }
      if (command.action === "publish" && saved) {
        expect(command.expected).toEqual({ draftId, activationId: null, baseDefinition });
        saved = {
          ...saved,
          activationId,
          publishedDraftId: draftId,
          publishedGraphRevisionId: graphRevisionId,
        };
        return Response.json({
          action: "publish",
          receipt: { draftId, digest, created: true, activationId, graphRevisionId },
        });
      }
    }
    if (saved && url === `${endpoint}?draftId=${draftId}`) return Response.json(saved);
    throw new Error(`Unexpected template request for ${url}.`);
  });
  vi.stubGlobal("fetch", fetch);
  openEditor(empty, {
    ...choices,
    prompts: [prompt, reviewer],
    profiles: [{ ...profile, templateRole: { promptRevisionId: prompt.id, canRunForeman: true } }],
    templateSource: {
      label: "Specification",
      anyoneCanApprove: false,
      approverMemberIds: [approver],
      hasRequiredEvidence: true,
      canDraftProductScope: true,
    },
  });

  const save = screen.getByRole("button", { name: "Save draft" });
  expect(save).toBeDisabled();
  for (const role of ["Foreman profile", "Implementation profile", "Support profile"]) {
    fireEvent.click(screen.getByRole("combobox", { name: role }));
    fireEvent.click(await screen.findByRole("option", { name: /Activated role/ }));
  }
  fireEvent.click(screen.getByRole("combobox", { name: "Reviewer prompt revision" }));
  fireEvent.click(await screen.findByRole("option", { name: reviewer.label }));
  fireEvent.click(screen.getByRole("button", { name: "Apply template" }));
  fireEvent.click(screen.getByText("Advanced step settings"));
  expect(screen.getByRole("textbox", { name: "Step ID" })).toHaveValue("scope.approval");
  fireEvent.click(save);
  await screen.findByText("Draft saved.");
  fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
  await screen.findByText("Workflow published.");
});

it("protects template picks before applying the template and clears the warning if reverted", async () => {
  const profile = {
    id: id(44),
    digest,
    label: "Activated role",
    templateRole: { promptRevisionId: laterPrompt.id, canRunForeman: true },
  };
  openEditor(
    {
      ...initial,
      template: { id: "incident-analysis", version: 1 },
      graph: null,
      draftId: null,
      draftBaseDefinition: null,
      draftDigest: null,
    },
    {
      ...choices,
      profiles: [profile],
      templateSource: {
        label: "Approval",
        anyoneCanApprove: true,
        approverMemberIds: [],
        hasRequiredEvidence: false,
        canDraftProductScope: false,
      },
    },
  );
  const foreman = screen.getByRole("combobox", { name: "Foreman profile" });
  fireEvent.click(foreman);
  fireEvent.click(await screen.findByRole("option", { name: "Activated role" }));
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  const all = screen.getByRole("link", { name: "All workflows" });
  all.focus();
  fireEvent.click(all);
  const dialog = await screen.findByRole("alertdialog", { name: "Leave this workflow?" });
  const keep = within(dialog).getByRole("button", { name: "Keep editing" });
  expect(keep).toHaveFocus();
  fireEvent.click(keep);
  expect(router.push).not.toHaveBeenCalled();
  expect(foreman).toHaveAttribute("data-value", profile.id);
  fireEvent.click(foreman);
  fireEvent.click(await screen.findByRole("option", { name: "Choose an activated Codex profile" }));
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(window.sessionStorage.length).toBe(0);
});

it("keeps stale edits until reload is confirmed, then restores a kept copy without publishing it", async () => {
  const liveId = id(45);
  const newer = {
    ...initial,
    draftId: id(46),
    activationId: id(47),
    publishedDraftId: liveId,
    recentDrafts: [
      { id: id(46), revision: 25 },
      { id: liveId, revision: 1 },
    ],
  };
  const fetch = vi.fn(async (url: string) =>
    url.endsWith("includeChoices=true")
      ? Response.json({ snapshot: newer, choices })
      : Response.json({ error: "Draft changed." }, { status: 409 }),
  );
  vi.stubGlobal("fetch", fetch);
  openEditor();
  fireEvent.click(screen.getByRole("button", { name: "Add step" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText(/Your edits are still here/);
  expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Load current draft" }));
  fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Load current draft" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Keep a recovery copy and load latest" }),
  );
  await screen.findByText("Editing draft 25");
  expect(screen.getByText("Live revision 1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Publish draft 25" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Review recovery copy" }));
  expect(await screen.findByText(/This copy predates the latest draft/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Restore as unsaved changes" }));
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Publish draft 25" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    within(screen.getByRole("list", { name: "Ordered workflow steps" })).getByRole("button", {
      name: /Checkpoint/,
    }),
  ).toBeInTheDocument();
});

it("offers interrupted changes only to their owner and can open the history link after discard", async () => {
  const liveId = id(48);
  const current = {
    ...initial,
    activationId: id(49),
    publishedDraftId: liveId,
    recentDrafts: [
      { id: initial.draftId!, revision: 4 },
      { id: liveId, revision: 2 },
    ],
  };
  const { unmount } = openEditor(current);
  fireEvent.click(screen.getByRole("button", { name: "Add step" }));
  unmount();
  const asOtherOwner = openEditor(current, choices, id(54));
  expect(screen.queryByRole("button", { name: "Review recovery copy" })).toBeNull();
  asOtherOwner.unmount();
  openEditor(current);
  fireEvent.click(screen.getByRole("button", { name: "Review recovery copy" }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore as unsaved changes" }));
  const liveLink = screen.getByRole("link", { name: "Inspect live revision 2" });
  fireEvent.click(liveLink);
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes and leave" }));
  expect(router.push).toHaveBeenCalledWith(liveLink.getAttribute("href"));
  expect(window.sessionStorage.length).toBe(0);
});

it("distinguishes old and live historical deep links without enabling mutations", () => {
  const liveId = id(51);
  const oldId = id(52);
  const current = {
    ...initial,
    activationId: id(53),
    publishedDraftId: liveId,
    selectedDraftId: oldId,
    selectedDraftGraph: initial.graph,
    recentDrafts: [
      { id: initial.draftId!, revision: 25 },
      { id: liveId, revision: 3 },
      { id: oldId, revision: 1 },
    ],
  };
  const { unmount } = openEditor(current);
  expect(screen.getByText("Saved draft 1 · Read only")).toBeInTheDocument();
  expect(screen.getByText("Viewing an inactive revision")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Publish draft/ })).toBeNull();
  unmount();
  openEditor({ ...current, selectedDraftId: liveId });
  expect(screen.getByText("Saved draft 3 · Read only")).toBeInTheDocument();
  expect(screen.getByText("Live revision 3 · Viewing live")).toBeInTheDocument();
});

it("focuses the parent control for indexed route and approver diagnostics", async () => {
  const snapshot = {
    ...initial,
    graph: workflowGraphSchema.parse({
      schemaVersion: 1,
      kind: "graph",
      entryNodeId: "triage",
      nodes: [
        { id: "triage", kind: "route", agentPromptRevisionId: missingPrompt },
        { id: "approve", kind: "human-gate", anyoneCanApprove: false, approverMemberIds: [id(55)] },
      ],
      edges: [{ id: "send", kind: "route", from: "triage", to: "approve" }],
      grants: [],
      routePolicy: {
        maxNodeVisits: 5,
        maxLoopTraversals: 0,
        nodes: {
          triage: {
            minimumConfidence: 0.5,
            allowedDestinationIds: ["approve"],
            fallback: { kind: "clarification" },
          },
        },
      },
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: "Resolve the workflow diagnostics.",
          diagnostics: [
            {
              path: ["routePolicy", "nodes", "triage", "allowedDestinationIds", 0],
              message: "Choose a separate route.",
            },
            { path: ["nodes", 1, "approverMemberIds", 0], message: "Choose an active member." },
          ],
        },
        { status: 422 },
      ),
    ),
  );
  openEditor(snapshot);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Minimum confidence" }), {
    target: { value: "0.7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const memberDiagnostic = await screen.findByRole("button", { name: /Choose an active member/ });
  const destinations = screen.getByRole("listbox", { name: "Allowed route destinations" });
  expect(destinations).toHaveFocus();
  expect(destinations).toHaveAccessibleDescription("Choose a separate route.");
  fireEvent.click(memberDiagnostic);
  const members = screen.getByRole("listbox", { name: "Required approvers" });
  expect(members).toHaveFocus();
  expect(members).toHaveAccessibleDescription(/Choose an active member/);
});
