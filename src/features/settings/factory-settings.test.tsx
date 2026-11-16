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

it("preserves two dirty sections on reload and saves only against the version each section opened", async () => {
  const newer: FactorySettingsSnapshot = {
    ...first,
    draft: secondDraft,
    agent: { ...first.agent, model: "gpt-5.6" },
  };
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") {
      return Response.json({ snapshot: fetch.mock.calls.length === 1 ? first : newer });
    }
    const command = factorySettingsCommandSchema.parse(JSON.parse(String(init.body)));
    if (command.action === "save") {
      if (command.expectedDraftId !== secondDraft.id) {
        return Response.json({ error: "Draft changed." }, { status: 409 });
      }
      if (command.patch.kind !== "agent") throw new Error("Unexpected patch");
      return Response.json({
        snapshot: { ...newer, agent: command.patch.agent, draft: acceptedDraft },
      });
    }
    return Response.json({
      snapshot: { ...newer, activationNumber: 2, published: acceptedDraft, draft: null },
    });
  });
  vi.stubGlobal("fetch", fetch);

  render(
    <FactorySettingsProvider canManage workspaceId={workspaceId}>
      <FactorySettingsPanel />
      <AgentConfigSection
        canManage
        extraContent={<ExecutionPolicySection canManage workspaceId={workspaceId} />}
        initialAgentConfig={{}}
        setFlashMessage={vi.fn()}
        workspaceId={workspaceId}
      />
    </FactorySettingsProvider>,
  );

  const model = await screen.findByRole("textbox", { name: "Model" });
  const repairs = screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ });
  expect(model).toHaveValue("gpt-5.5");
  expect(repairs).toHaveValue(2);
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled();
  fireEvent.change(model, { target: { value: "gpt-local" } });
  fireEvent.change(repairs, { target: { value: "8" } });
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Reload configuration" }));
  expect(await screen.findByText(secondDraft.digest.slice(0, 12))).toBeInTheDocument();
  expect(model).toHaveValue("gpt-local");
  expect(repairs).toHaveValue(8);
  expect(screen.getAllByRole("button", { name: /Discard .* edits/ })).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "Save execution policy draft" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(fetch.mock.calls[2]?.[0]).toMatch(/\/factory-definition\/settings$/);
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
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
  expect(await screen.findByText(acceptedDraft.digest.slice(0, 12))).toBeInTheDocument();
  expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toMatchObject({
    action: "save",
    expectedActivationNumber: 1,
    expectedDraftId: secondDraft.id,
    patch: { kind: "agent", agent: { model: "gpt-reapplied" } },
  });
  expect(repairs).toHaveValue(8);
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Discard execution policy edits" }));
  expect(screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ })).toHaveValue(2);
  fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
  expect(await screen.findByText("No saved draft")).toBeInTheDocument();
  expect(JSON.parse(String(fetch.mock.calls[4]?.[1]?.body))).toEqual({
    action: "publish",
    expectedActivationNumber: 1,
    draftId: acceptedDraft.id,
  });
});
