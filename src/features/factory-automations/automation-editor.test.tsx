// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import {
  factoryAutomationDefinitionSchema,
  factoryAutomationSnapshotSchema,
} from "@/lib/factory-automations/contracts";
import type { AutomationSetupOptions } from "@/lib/factory-automations/operator-contracts";

import { AutomationEditor } from "./automation-editor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

function fixtureId(tail: string) {
  return `66410000-0000-4000-8000-000000000${tail}`;
}

const assignment = {
  definitionRevisionId: fixtureId("001"),
  agentId: fixtureId("002"),
  executionGrant: { id: fixtureId("003"), version: 1 },
  servicePrincipalId: fixtureId("004"),
  budgetPayerMemberId: fixtureId("005"),
  credentialBindingId: fixtureId("006"),
};
const setup: AutomationSetupOptions = {
  assignment: { ...assignment, definitionDigest: "a".repeat(64), agentName: "Fixture reviewer" },
  repositories: [],
  workflows: [],
};

function snapshot(revision: number, name: string) {
  const id = fixtureId(`01${revision}`);
  const { definitionRevisionId, agentId, ...authority } = assignment;
  return factoryAutomationSnapshotSchema.parse({
    automationId: fixtureId("010"),
    draftRevisionId: id,
    publishedRevisionId: null,
    archivedAt: null,
    revision: {
      id,
      revision,
      definition: factoryAutomationDefinitionSchema.parse({
        ...authority,
        name,
        target: { kind: "agent", definitionRevisionId, agentId },
        trigger: { kind: "schedule", cron: "0 9 * * *", timeZone: "Etc/UTC" },
        filters: {},
      }),
      createdAt: "2026-11-23T22:00:00Z",
      createdByMemberId: fixtureId("007"),
    },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("retains a stale edit and uses the current revision only after explicit rebase", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({}, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ automation: snapshot(2, "Other manager edit") }))
    .mockResolvedValueOnce(Response.json({ automation: snapshot(3, "My retained edit") }));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(
    <AutomationEditor
      workspaceId={fixtureId("009")}
      workspaceSlug="fixture"
      factoryId={fixtureId("008")}
      revisionSelected={false}
      initial={snapshot(1, "Saved fixture")}
      setup={setup}
      setupFailed={false}
    />,
  );

  const name = screen.getByRole("textbox", { name: "Rule name" });
  const save = screen.getByRole("button", { name: "Save draft" });
  await user.clear(name);
  await user.type(name, "My retained edit");
  expect(screen.getByRole("button", { name: "Publish and enable" })).toBeDisabled();
  await user.click(save);

  expect(await screen.findByRole("alert")).toHaveTextContent("Your field values are still here");
  expect(name).toHaveValue("My retained edit");
  expect(save).toBeDisabled();
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    action: "save",
    expectedRevisionId: fixtureId("011"),
    definition: { name: "My retained edit" },
  });

  await user.click(screen.getByRole("button", { name: "Use latest revision and keep edits" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Revision 2 is current");
  expect(name).toHaveValue("My retained edit");
  expect(fetch.mock.calls[1][1]?.method).toBeUndefined();

  await user.click(save);
  expect(await screen.findByRole("status")).toHaveTextContent("Draft revision 3 saved");
  expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toMatchObject({
    action: "save",
    expectedRevisionId: fixtureId("012"),
    definition: { name: "My retained edit" },
  });
});
