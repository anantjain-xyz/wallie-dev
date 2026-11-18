// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import { FactoryDefinitionEditor } from "@/features/factory-definition/definition-editor";
import type { CandidateSmokeTest } from "@/lib/factory-definitions/candidate-smoke-contracts";
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
    agent,
    sandboxProvider,
    operatingRulesMd,
    schemaVersion,
    kind: workflowKind,
  } = source;
  return {
    id: id(number),
    kind,
    createdAt,
    digest: number.toString(16).repeat(64),
    sourceDraftId: kind === "revision" ? id(10) : null,
    source,
    bundle: {
      agent,
      sandboxProvider,
      operatingRulesMd,
      schemaVersion,
      kind: workflowKind,
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
  sandboxProvider: "e2b",
  operatingRulesMd: "Earlier rule.",
});
const activation = (document: FactoryEditorDocument, number: number) => ({
  id: id(100 + number),
  revisionId: document.id,
  activationNumber: number,
  previousActivationNumber: number === 1 ? null : number - 1,
  createdAt,
});

function receipt(
  doc: FactoryEditorDocument,
  status: CandidateSmokeTest["status"],
  suffix: number,
): CandidateSmokeTest {
  return {
    id: id(suffix),
    target: { kind: doc.kind, id: doc.id },
    definitionDigest: doc.digest,
    baseActivationNumber: 2,
    policyVersion: 1,
    status,
    createdAt,
    finishedAt: status === "running" ? null : createdAt,
    evidence:
      status === "passed"
        ? {
            stageCount: 1,
            completedStageCount: 1,
            stages: [{ stageId: id(4), promptDigest: "b".repeat(64) }],
          }
        : null,
    error: status === "failed" ? "The serial test failed." : null,
  };
}

function setup({
  selection = null,
  initialDraftPasses = true,
}: {
  selection?: { draft: string; test: string } | null;
  initialDraftPasses?: boolean;
} = {}) {
  let snapshot: FactoryEditorSnapshot = {
    activationNumber: 2,
    published,
    draft,
    baseline: null,
    readySandboxProviders: ["vercel"],
  };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const records = new Map([published, previous, draft].map((document) => [document.id, document]));
  const reads: string[] = [];
  const tests = new Map<string, CandidateSmokeTest[]>([
    [draft.id, initialDraftPasses ? [receipt(draft, "passed", 41)] : []],
    [previous.id, [receipt(previous, "passed", 42)]],
  ]);
  let testCount = 50;
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    const { pathname, searchParams } = new URL(url, "http://localhost");
    if (pathname === `${endpoint}/capability-check`) return Response.json({ check: null });
    if (pathname.startsWith(`${endpoint}/candidate-tests`)) {
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body));
        requests.push({ path: pathname, body });
        const candidate = records.get(body.target.id);
        if (!candidate) throw new Error("Unknown candidate");
        const running = receipt(candidate, "running", testCount++);
        tests.set(candidate.id, [running, ...(tests.get(candidate.id) ?? [])]);
        return Response.json({ test: running }, { status: 202 });
      }
      const testId = pathname.split("/").at(-1);
      const targetId = searchParams.get("targetId") ?? "";
      reads.push(url);
      const matches = (tests.get(targetId) ?? []).filter(
        ({ definitionDigest }) => definitionDigest === searchParams.get("digest"),
      );
      if (testId !== "candidate-tests") {
        return Response.json({ test: matches.find(({ id }) => id === testId) });
      }
      const latest = matches[0];
      const eligible =
        latest?.status === "passed" && latest.baseActivationNumber === snapshot.activationNumber;
      return Response.json({
        tests: matches.map((test) => ({ ...test, evidence: null })),
        eligibility: {
          eligible,
          reason: eligible ? null : "A current passing smoke test is required.",
          activationNumber: snapshot.activationNumber,
        },
      });
    }
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
      selection={selection}
      workspaceId={id(1)}
      workspaceSlug="acme"
    />,
    { wrapper: PortalRootProvider },
  );
  return {
    requests,
    reads,
    completeTest(targetId: string, status: "passed" | "failed") {
      const list = tests.get(targetId);
      const doc = records.get(targetId);
      if (!doc || !list?.[0]) throw new Error("No running test");
      tests.set(targetId, [{ ...receipt(doc, status, 99), id: list[0].id }, ...list.slice(1)]);
      fireEvent(window, new Event("focus"));
    },
    updateReadyProviders(readySandboxProviders: FactoryEditorSnapshot["readySandboxProviders"]) {
      snapshot = { ...snapshot, readySandboxProviders };
    },
    advanceActivation() {
      snapshot = { ...snapshot, activationNumber: snapshot.activationNumber + 1 };
      fireEvent(window, new Event("focus"));
    },
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
  const { requests, completeTest } = setup();
  await screen.findByRole("textbox", { name: "Model" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "JSON source" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Definition JSON" }), {
    target: { value: JSON.stringify({ ...source, agent: { ...source.agent, model: "gpt-5.6" } }) },
  });
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
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
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
  const start = await screen.findByRole("button", { name: "Run configuration test" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await screen.findByRole("button", { name: "Cancel test" });
  expect(requests[2]).toMatchObject({
    body: { target: { kind: "draft", id: id(8) }, expectedDigest: "8".repeat(64) },
  });
  completeTest(id(8), "passed");
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
  await screen.findByText("Draft published for new sessions.");
  expect(requests[3]).toEqual({
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
  const rollback = await screen.findByRole("button", { name: "Roll back to this revision" });
  await waitFor(() => expect(rollback).toBeEnabled());
  fireEvent.click(rollback);
  const confirmation = await screen.findByRole("alertdialog", { name: "Activate this revision?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Activate revision" }));
  await screen.findByText("Selected revision activated for new sessions.");
  expect(requests[0]).toEqual({
    path: endpoint,
    body: { action: "rollback", expectedActivationNumber: 2, revisionId: previous.id },
  });
});

it("explains a newer activation and preserves unsaved input when the reviewer reloads", async () => {
  const { advanceActivation, requests } = setup();
  fireEvent.click(await screen.findByRole("button", { name: /Activation #1/ }));
  const draftTests = within(screen.getByRole("region", { name: "Draft configuration tests" }));
  const revisionTests = within(
    await screen.findByRole("region", { name: "Revision configuration tests" }),
  );
  const publish = screen.getByRole("button", { name: "Publish draft" });
  const rollback = screen.getByRole("button", { name: "Roll back to this revision" });
  const draftRetest = draftTests.getByRole("button", { name: "Retest configuration" });
  const revisionRetest = await revisionTests.findByRole("button", { name: "Retest configuration" });
  await waitFor(() => {
    expect(draftRetest).toBeEnabled();
    expect(revisionRetest).toBeEnabled();
    expect(publish).toBeEnabled();
    expect(rollback).toBeEnabled();
  });

  advanceActivation();

  const reloadHint = /active factory revision changed.*reload the definition/i;
  expect(await draftTests.findByText(reloadHint)).toBeVisible();
  expect(await revisionTests.findByText(reloadHint)).toBeVisible();
  expect(draftRetest).toBeDisabled();
  expect(revisionRetest).toBeDisabled();
  expect(publish).toBeDisabled();
  expect(rollback).toBeDisabled();

  const model = screen.getByRole("textbox", { name: "Model" });
  fireEvent.change(model, { target: { value: "gpt-5.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload definition" }));
  expect(await screen.findByRole("button", { name: "Apply edits to latest draft" })).toBeVisible();
  expect(model).toHaveValue("gpt-5.6");
  expect(requests).toHaveLength(0);
});

it("checks readiness for the selected revision's provider and refreshes it with the editor", async () => {
  const { updateReadyProviders } = setup();
  const runCheck = () => screen.getByRole("button", { name: "Run capability check" });
  await screen.findByRole("button", { name: "Run capability check" });
  await waitFor(() => expect(runCheck()).toBeEnabled());

  fireEvent.click(screen.getByRole("button", { name: /Activation #1/ }));
  expect(
    await screen.findByText("Connect a sandbox provider before running a capability check."),
  ).toBeVisible();
  expect(runCheck()).toBeDisabled();

  updateReadyProviders(["vercel", "e2b"]);
  fireEvent.click(screen.getByRole("button", { name: "Reload definition" }));
  await waitFor(() => expect(runCheck()).toBeEnabled());
});

it("defers exact receipt evidence and retains a failed attempt when a retest completes", async () => {
  const { reads, requests, completeTest } = setup({ initialDraftPasses: false });
  const start = await screen.findByRole("button", { name: "Run configuration test" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  fireEvent.click(start);
  await screen.findByRole("button", { name: "Cancel test" });
  expect(requests).toHaveLength(1);
  expect(reads.every((url) => url.includes("/candidate-tests?"))).toBe(true);
  completeTest(draft.id, "failed");
  const retest = await screen.findByRole("button", { name: "Retest configuration" });
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
  fireEvent.click(retest);
  await screen.findByRole("button", { name: "Cancel test" });
  completeTest(draft.id, "passed");
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());
  expect(screen.getAllByRole("button", { name: /View evidence for test/ })).toHaveLength(2);
  expect(reads.every((url) => url.includes("/candidate-tests?"))).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: /View evidence for test/ })[0]);
  expect(await screen.findByText("b".repeat(64))).toBeVisible();
  expect(reads).toContain(
    `${endpoint}/candidate-tests/${id(51)}?targetKind=draft&targetId=${draft.id}&digest=${draft.digest}`,
  );
});

it("opens a permalink at a specific saved test receipt and scrolls to it after loading", async () => {
  const originalUrl = window.location.href;
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  window.history.replaceState(null, "", "#candidate-tests");
  try {
    const { reads } = setup({ selection: { draft: draft.id, test: id(41) } });
    expect(await screen.findByText("b".repeat(64))).toBeVisible();
    expect(reads).toContain(
      `${endpoint}/candidate-tests/${id(41)}?targetKind=draft&targetId=${draft.id}&digest=${draft.digest}`,
    );
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start" });
    expect(scrollIntoView.mock.instances[0]).toBe(
      window.document.getElementById("candidate-tests"),
    );
  } finally {
    window.history.replaceState(null, "", originalUrl);
    if (originalScroll) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  }
});
