// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AgentConfigSection } from "@/features/settings/agent-config-section";
import { ExecutionPolicySection } from "@/features/settings/execution-policy-section";
import {
  FactorySettingsPanel,
  FactorySettingsProvider,
} from "@/features/settings/factory-settings";
import {
  factorySettingsCommandSchema,
  type FactorySettingsCommand,
  type FactorySettingsSnapshot,
} from "@/lib/factory-definitions/settings-contracts";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const firstDraft = { id: "00000000-0000-4000-8000-000000000002", digest: "a".repeat(64) };
const secondDraft = { id: "00000000-0000-4000-8000-000000000003", digest: "b".repeat(64) };
const acceptedDraft = { id: "00000000-0000-4000-8000-000000000004", digest: "c".repeat(64) };
const published = { id: "00000000-0000-4000-8000-000000000005", digest: "d".repeat(64) };

const first: FactorySettingsSnapshot = {
  activationNumber: 1,
  published,
  draft: firstDraft,
  repositoryId: "00000000-0000-4000-8000-000000000006",
  publishedStages: [],
  pipeline: {
    id: "00000000-0000-4000-8000-000000000007",
    name: "Pipeline",
    isDefault: true,
    operatingRulesMd: "",
    stages: [],
    archivedStages: [],
  },
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: null,
    concurrencyLimit: 1,
    stallTimeoutMs: 900_000,
    maxRetries: 3,
    maxTurns: 5,
  },
  executionPolicy: {
    version: 1,
    maxRepairAttempts: 2,
    maxExecutionMs: 3_600_000,
    maxTotalTokens: null,
    maxCostUsd: null,
  },
  deliveryPolicy: null,
  sandboxProvider: "vercel",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSettings() {
  return render(
    <FactorySettingsProvider canManage workspaceId={workspaceId}>
      <FactorySettingsPanel editorHref="/w/demo/settings/factory-definition" />
      <AgentConfigSection
        canManage
        extraContent={<ExecutionPolicySection canManage workspaceId={workspaceId} />}
        initialAgentConfig={{}}
        setFlashMessage={vi.fn()}
        workspaceId={workspaceId}
      />
    </FactorySettingsProvider>,
  );
}

const allDrafts = [firstDraft, secondDraft, acceptedDraft];
const testId = "00000000-0000-4000-8000-000000000008";

function stubFactorySettings(
  handle: (command: FactorySettingsCommand | null) => Response,
  passingDrafts = allDrafts,
) {
  const api = `/api/workspaces/${workspaceId}/factory-definition`;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith(`${api}/candidate-tests?`)) {
      const query = new URL(url, "http://wallie.test").searchParams;
      const draft = passingDrafts.find(
        ({ id, digest }) => id === query.get("targetId") && digest === query.get("digest"),
      );
      expect(query.get("targetKind")).toBe("draft");
      const tests = draft
        ? [
            {
              id: testId,
              target: { kind: "draft", id: draft.id },
              definitionDigest: draft.digest,
              baseActivationNumber: 1,
              policyVersion: 1,
              status: "passed",
              createdAt: "2026-11-16T18:00:00Z",
              finishedAt: "2026-11-16T18:01:00Z",
              evidence: null,
              error: null,
            },
          ]
        : [];
      return Response.json({
        tests,
        eligibility: {
          activationNumber: 1,
          eligible: Boolean(draft),
          reason: draft
            ? null
            : "A current passing smoke test is required for the exact factory candidate.",
          testId: draft ? testId : null,
          canTest: true,
        },
      });
    }
    if (url !== `${api}/settings`) return new Response(null, { status: 404 });

    const command =
      init?.method === "POST"
        ? factorySettingsCommandSchema.parse(JSON.parse(String(init.body)))
        : null;
    return handle(command);
  });
}

it("saves two sections edited in the same tab and publishes their combined draft", async () => {
  let snapshot = first;
  const commands: FactorySettingsCommand[] = [];
  stubFactorySettings((command) => {
    if (!command) return Response.json({ snapshot });
    commands.push(command);
    const draftId = command.action === "publish" ? command.draftId : command.expectedDraftId;
    if (
      draftId !== snapshot.draft?.id ||
      command.expectedActivationNumber !== snapshot.activationNumber
    ) {
      return Response.json({ error: "Draft changed." }, { status: 409 });
    }
    if (command.action === "publish") {
      snapshot = { ...snapshot, activationNumber: 2, published: snapshot.draft, draft: null };
    } else if (command.patch.kind === "agent") {
      snapshot = { ...snapshot, agent: command.patch.agent, draft: secondDraft };
    } else if (command.patch.kind === "execution-policy") {
      snapshot = { ...snapshot, executionPolicy: command.patch.requirements, draft: acceptedDraft };
    } else {
      throw new Error("Unexpected patch");
    }
    return Response.json({ snapshot });
  });

  renderSettings();

  const model = await screen.findByRole("textbox", { name: "Model" });
  const repairs = () => screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ });
  fireEvent.change(model, { target: { value: "gpt-local" } });
  fireEvent.change(repairs(), { target: { value: "8" } });

  fireEvent.click(screen.getByRole("button", { name: "Save agent draft" }));
  const revisedDraft = await screen.findByText(secondDraft.digest);
  expect(revisedDraft.closest("details")).not.toHaveAttribute("open");
  expect(repairs()).toHaveValue(8);
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Save execution policy draft" }));
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[0]).toMatchObject({
    action: "save",
    expectedDraftId: firstDraft.id,
    patch: { kind: "agent", agent: { model: "gpt-local" } },
  });
  expect(commands[1]).toMatchObject({
    action: "save",
    expectedDraftId: secondDraft.id,
    patch: { kind: "execution-policy", requirements: { maxRepairAttempts: 8 } },
  });
  expect(await screen.findByText(acceptedDraft.digest)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());

  fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
  expect(await screen.findByText("No saved draft")).toBeInTheDocument();
  expect(commands[2]).toEqual({
    action: "publish",
    expectedActivationNumber: 1,
    draftId: acceptedDraft.id,
  });
  expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("gpt-local");
  expect(repairs()).toHaveValue(8);
});

it("keeps a conflict when another dirty section changed before the first draft was saved", async () => {
  const initial = { ...first, activationNumber: 0, published: null, draft: null };
  stubFactorySettings((command) => {
    if (!command) return Response.json({ snapshot: initial });
    if (command.action !== "save" || command.patch.kind !== "execution-policy") {
      throw new Error("Unexpected command");
    }
    return Response.json({
      snapshot: {
        ...initial,
        draft: secondDraft,
        agent: { ...initial.agent, model: "gpt-new-base" },
        executionPolicy: command.patch.requirements,
      },
    });
  });

  renderSettings();

  const model = await screen.findByRole("textbox", { name: "Model" });
  const repairs = screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ });
  fireEvent.change(model, { target: { value: "gpt-local" } });
  fireEvent.change(repairs, { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "Save execution policy draft" }));

  expect(await screen.findByRole("button", { name: "Discard coding agent edits" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("gpt-local");
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
});

it("preserves two dirty sections on reload and saves only against the version each section opened", async () => {
  const newer: FactorySettingsSnapshot = {
    ...first,
    draft: secondDraft,
    agent: { ...first.agent, model: "gpt-5.6" },
  };
  let snapshot = first;
  const commands: FactorySettingsCommand[] = [];
  stubFactorySettings((command) => {
    if (!command) return Response.json({ snapshot });
    commands.push(command);
    if (command.action === "save") {
      if (command.expectedDraftId !== secondDraft.id) {
        return Response.json({ error: "Draft changed." }, { status: 409 });
      }
      if (command.patch.kind !== "agent") throw new Error("Unexpected patch");
      snapshot = { ...newer, agent: command.patch.agent, draft: acceptedDraft };
    } else {
      snapshot = { ...snapshot, activationNumber: 2, published: acceptedDraft, draft: null };
    }
    return Response.json({ snapshot });
  });

  renderSettings();

  const model = await screen.findByRole("textbox", { name: "Model" });
  const repairs = screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ });
  expect(model).toHaveValue("gpt-5.5");
  expect(repairs).toHaveValue(2);
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());
  fireEvent.change(model, { target: { value: "gpt-local" } });
  fireEvent.change(repairs, { target: { value: "8" } });
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();

  snapshot = newer;
  fireEvent.click(screen.getByRole("button", { name: "Reload configuration" }));
  expect(await screen.findByText(secondDraft.digest)).toBeInTheDocument();
  expect(model).toHaveValue("gpt-local");
  expect(repairs).toHaveValue(8);
  expect(screen.getAllByRole("button", { name: /Discard .* edits/ })).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "Save execution policy draft" }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]).toMatchObject({
    action: "save",
    expectedActivationNumber: 1,
    expectedDraftId: firstDraft.id,
    patch: { kind: "execution-policy", requirements: { maxRepairAttempts: 8 } },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save agent draft" })).toBeEnabled(),
  );

  fireEvent.click(screen.getByRole("button", { name: "Discard coding agent edits" }));
  expect(model).toHaveValue("gpt-5.6");
  expect(repairs).toHaveValue(8);
  fireEvent.change(model, { target: { value: "gpt-reapplied" } });
  fireEvent.click(screen.getByRole("button", { name: "Save agent draft" }));
  expect(await screen.findByText(acceptedDraft.digest)).toBeInTheDocument();
  expect(commands[1]).toMatchObject({
    action: "save",
    expectedActivationNumber: 1,
    expectedDraftId: secondDraft.id,
    patch: { kind: "agent", agent: { model: "gpt-reapplied" } },
  });
  expect(repairs).toHaveValue(8);
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Discard execution policy edits" }));
  expect(screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ })).toHaveValue(2);
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
  expect(await screen.findByText("No saved draft")).toBeInTheDocument();
  expect(commands[2]).toEqual({
    action: "publish",
    expectedActivationNumber: 1,
    draftId: acceptedDraft.id,
  });
});

it("requires a passing test for the current saved draft before publishing from Settings", async () => {
  let snapshot = first;
  const commands: FactorySettingsCommand[] = [];
  stubFactorySettings(
    (command) => {
      if (command) {
        commands.push(command);
        if (command.action !== "save" || command.patch.kind !== "agent") {
          throw new Error("Unexpected command");
        }
        snapshot = { ...snapshot, agent: command.patch.agent, draft: secondDraft };
      }
      return Response.json({ snapshot });
    },
    [firstDraft],
  );
  renderSettings();

  const model = await screen.findByRole("textbox", { name: "Model" });
  const publish = screen.getByRole("button", { name: "Publish draft" });
  expect(await screen.findByText("Ready to publish this draft.")).toBeVisible();
  expect(publish).toBeEnabled();

  fireEvent.change(model, { target: { value: "gpt-local" } });
  expect(publish).toBeDisabled();
  expect(screen.queryByText("Ready to publish this draft.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save agent draft" }));
  expect(
    await screen.findByText(
      "A current passing smoke test is required for the exact factory candidate.",
    ),
  ).toBeVisible();
  expect(publish).toBeDisabled();
  expect(screen.getByRole("link", { name: "Review configuration tests" })).toHaveAttribute(
    "href",
    "/w/demo/settings/factory-definition#candidate-tests",
  );
  fireEvent.click(publish);
  expect(commands).toHaveLength(1);
});
