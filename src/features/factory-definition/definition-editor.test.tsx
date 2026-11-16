// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import { FactoryDefinitionEditor } from "@/features/factory-definition/definition-editor";
import type {
  FactoryEditorDocument,
  FactoryEditorSnapshot,
} from "@/lib/factory-definitions/editor-contracts";
import type { SerialFactoryDefinition } from "@/lib/factory-definitions/schema";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const endpoint = `/api/workspaces/${id(1)}/factory-definition`;
const createdAt = "2026-11-15T20:00:00Z";

const source: SerialFactoryDefinition = {
  schemaVersion: 1,
  kind: "serial",
  pipeline: id(2),
  repository: id(3),
  sandboxProvider: "vercel",
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: null,
    concurrencyLimit: 1,
    stallTimeoutMs: 900_000,
    maxRetries: 3,
    maxTurns: 5,
  },
  executionPolicy: null,
  deliveryPolicy: null,
  skills: [],
  tools: [],
  operatingRulesMd: "",
  stages: [
    {
      id: id(4),
      slug: "plan",
      name: "Plan",
      description: "",
      promptTemplateMd: "Plan the session.",
      anyoneCanApprove: true,
      approverMemberIds: [],
    },
  ],
};

function document(
  number: number,
  kind: FactoryEditorDocument["kind"],
  source: SerialFactoryDefinition,
): FactoryEditorDocument {
  const {
    pipeline,
    repository,
    executionPolicy,
    deliveryPolicy,
    skills,
    tools,
    stages,
    ...runtime
  } = source;
  return {
    id: id(number),
    kind,
    createdAt,
    digest: number.toString(16).repeat(64),
    sourceDraftId: kind === "revision" ? id(10) : null,
    source,
    bundle: {
      ...runtime,
      pipelineId: pipeline,
      repositoryId: repository,
      executionPolicyRevisionId: executionPolicy,
      deliveryPolicyRevisionId: deliveryPolicy,
      skillIds: skills,
      toolIds: tools,
      operatingRuleStageIds: [],
      stages: stages.map((stage) => ({ ...stage, previousStageIds: [] })),
    },
  };
}

const published = document(5, "revision", source);
const draft = document(6, "draft", source);
const previous = document(7, "revision", {
  ...source,
  operatingRulesMd: "Earlier rule.",
});
const activation = (document: FactoryEditorDocument, number: number) => ({
  id: id(100 + number),
  revisionId: document.id,
  activationNumber: number,
  previousActivationNumber: number === 1 ? null : number - 1,
  createdAt,
});

function setup() {
  let snapshot: FactoryEditorSnapshot = { activationNumber: 2, published, draft, baseline: null };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const records = new Map([published, previous, draft].map((document) => [document.id, document]));
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    const { pathname, searchParams } = new URL(url, "http://localhost");
    if (pathname === `${endpoint}/capability-check`) return Response.json({ check: null });
    if (options?.method !== "POST") {
      if (pathname === endpoint) {
        const currentActivation = activation(
          snapshot.published ?? published,
          snapshot.activationNumber,
        );
        return Response.json({
          factoryId: id(9),
          currentActivation,
          activations: [currentActivation, activation(previous, 1)],
          nextBeforeActivationNumber: null,
        });
      }
      const selection = searchParams.get("revisionId") ?? searchParams.get("draftId");
      return Response.json(selection ? { document: records.get(selection) } : { snapshot });
    }

    const body = JSON.parse(String(options.body));
    requests.push({ path: pathname, body });
    if (body.expectedActivationNumber !== snapshot.activationNumber) {
      return Response.json({ error: "The activation changed." }, { status: 409 });
    }
    if (body.action === "rollback") {
      const selected = records.get(body.revisionId);
      if (!selected) throw new Error("Unknown revision");
      snapshot = {
        ...snapshot,
        published: selected,
        draft: null,
        activationNumber: snapshot.activationNumber + 1,
      };
      return Response.json({ activation: { revisionId: selected.id } });
    }
    if (body.action === "publish") {
      if (body.draftId !== snapshot.draft?.id || !snapshot.draft) {
        return Response.json({ error: "The draft changed." }, { status: 409 });
      }
      const next = { ...snapshot.draft, id: id(11), kind: "revision" as const };
      snapshot = { ...snapshot, published: next, draft: null, activationNumber: 3 };
      return Response.json({ snapshot: { activationNumber: 3 } });
    }
    if (body.expectedDraftId !== (snapshot.draft?.id ?? null)) {
      return Response.json({ error: "The draft changed." }, { status: 409 });
    }
    const nextSource =
      body.source.kind === "json" ? JSON.parse(body.source.text) : body.source.value;
    const next = document(8, "draft", nextSource);
    if (pathname.endsWith("/editor")) return Response.json({ content: next });
    snapshot = { ...snapshot, draft: next };
    records.set(next.id, next);
    return Response.json({ draft: { id: next.id } });
  });

  render(
    <FactoryDefinitionEditor
      repositories={[{ id: id(3), fullName: "acme/project", isArchived: false }]}
      selection={null}
      workspaceId={id(1)}
      workspaceSlug="acme"
    />,
    { wrapper: PortalRootProvider },
  );
  return {
    requests,
    updateDraft() {
      const next = document(10, "draft", { ...source, operatingRulesMd: "Externally updated." });
      snapshot = { ...snapshot, draft: next };
      records.set(next.id, next);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("round-trips source edits through the compiler and publishes the exact saved draft", async () => {
  const { requests } = setup();
  await screen.findByRole("textbox", { name: "Model" });
  fireEvent.click(screen.getByRole("button", { name: "JSON source" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Definition JSON" }), {
    target: { value: JSON.stringify({ ...source, agent: { ...source.agent, model: "gpt-5.6" } }) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Structured" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("gpt-5.6"),
  );
  expect(requests[0]).toMatchObject({
    path: `${endpoint}/editor`,
    body: { expectedActivationNumber: 2, expectedDraftId: draft.id, source: { kind: "json" } },
  });

  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved.");
  expect(requests[1]).toMatchObject({
    path: endpoint,
    body: {
      action: "draft",
      source: { kind: "structured", value: { agent: { model: "gpt-5.6" } } },
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
  await screen.findByText("Draft published for new sessions.");
  expect(requests[2]).toEqual({
    path: `${endpoint}/settings`,
    body: { action: "publish", expectedActivationNumber: 2, draftId: id(8) },
  });
});

it("retains conflicted input and reuses the newest write token only after explicit reapplication", async () => {
  const { requests, updateDraft } = setup();
  const model = await screen.findByRole("textbox", { name: "Model" });
  fireEvent.change(model, { target: { value: "gpt-5.6" } });
  updateDraft();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("The draft changed.");
  expect(model).toHaveValue("gpt-5.6");
  fireEvent.click(screen.getByRole("button", { name: "Reload definition" }));
  const apply = await screen.findByRole("button", { name: "Apply edits to latest draft" });
  expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  expect(model).toHaveValue("gpt-5.6");
  fireEvent.click(apply);
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved.");
  expect(requests[1]?.body).toMatchObject({
    expectedDraftId: id(10),
    source: { value: { agent: { model: "gpt-5.6" } } },
  });
});

it("activates an immutable selected revision using the displayed activation guard", async () => {
  const { requests } = setup();
  fireEvent.click(await screen.findByRole("button", { name: /Activation #1/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Roll back to this revision" }));
  const confirmation = await screen.findByRole("alertdialog", { name: "Activate this revision?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Activate revision" }));
  await screen.findByText("Selected revision activated for new sessions.");
  expect(requests[0]).toEqual({
    path: endpoint,
    body: { action: "rollback", expectedActivationNumber: 2, revisionId: previous.id },
  });
});
