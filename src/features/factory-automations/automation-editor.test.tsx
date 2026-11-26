// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import {
  factoryAutomationDefinitionSchema,
  factoryAutomationSnapshotSchema,
} from "@/lib/factory-automations/contracts";
import type { AutomationSetupOptions } from "@/lib/factory-automations/operator-contracts";

import { AutomationEditor } from "./automation-editor";
import { AutomationLinearCatalog } from "./automation-linear-catalog";

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

function snapshot(revision: number, name: string, cron = "0 9 * * *", timeZone = "Etc/UTC") {
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
        trigger: { kind: "schedule", cron, timeZone },
        filters: {},
      }),
      createdAt: "2026-11-23T22:00:00Z",
      createdByMemberId: fixtureId("007"),
    },
  });
}

const linearEndpoint = "/api/example/connectors";
const linearMappingId = fixtureId("101");
const savedStateId = fixtureId("102");

async function rebaseToLinear(canDiscover: boolean) {
  const latest = snapshot(2, "Saved fixture");
  const installationId = fixtureId("103");
  const tenantId = fixtureId("104");
  const teamId = fixtureId("105");
  const fetch = vi
    .fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input), "https://wallie.test");
      if (url.pathname === linearEndpoint)
        return Response.json({
          canConfigure: true,
          installations: [
            {
              id: installationId,
              provider: "linear",
              generation: 1,
              status: "connected",
              externalTenantId: tenantId,
              externalInstallationId: tenantId,
            },
          ],
          resources: [
            {
              id: linearMappingId,
              provider: "linear",
              kind: "team",
              installationId,
              externalId: teamId,
              label: null,
              mappingRevision: 1,
              enabled: true,
              connectionStatus: "connected",
              githubRequests: [],
            },
          ],
        });
      if (url.pathname !== `${linearEndpoint}/catalog`) throw new Error("Unexpected request");
      const kind = url.searchParams.get("kind");
      return Response.json({
        provider: "linear",
        kind,
        tenant: { id: tenantId, label: "Example workspace" },
        resources:
          kind === "state"
            ? [
                { id: savedStateId, label: "In review", teamId },
                { id: fixtureId("106"), label: "Done", teamId },
              ]
            : [],
        nextCursor: null,
      });
    })
    .mockResolvedValueOnce(Response.json({}, { status: 409 }))
    .mockResolvedValueOnce(
      Response.json({
        automation: {
          ...latest,
          revision: {
            ...latest.revision,
            definition: {
              ...latest.revision.definition,
              trigger: { kind: "issue-state" },
              filters: { stateIds: [savedStateId], teamIds: [], projectIds: [] },
            },
          },
        },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(
    <AutomationLinearCatalog
      canDiscover={canDiscover}
      endpoint={linearEndpoint}
      integrationsHref="/settings?category=integrations"
      revisionUsesLinear={false}
      savedIds={{ state: [], team: [], project: [] }}
    >
      <AutomationEditor
        workspaceId={fixtureId("009")}
        workspaceSlug="fixture"
        factoryId={fixtureId("008")}
        revisionSelected={false}
        initial={snapshot(1, "Saved fixture")}
        setup={setup}
        setupFailed={false}
      />
    </AutomationLinearCatalog>,
  );
  expect(fetch).not.toHaveBeenCalled();
  const name = screen.getByRole("textbox", { name: "Rule name" });
  await user.clear(name);
  await user.type(name, "My retained edit");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await user.click(
    await screen.findByRole("button", { name: "Use latest revision and keep edits" }),
  );
  expect(await screen.findByText(/Revision 2 is current/)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Rule name" })).toHaveValue("My retained edit");
  expect(screen.getByRole("combobox", { name: "Trigger" })).toHaveTextContent("Linear issue state");
  return { user, fetch };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  { mode: "new", savedTimeZone: undefined, timeZone: "Pacific/Chatham" },
  { mode: "existing", savedTimeZone: "Asia/Tokyo", timeZone: "Europe/London" },
])("saves the $mode schedule draft's time zone", async ({ savedTimeZone, timeZone }) => {
  const name = "Schedule fixture";
  const cron = "0 9 * * *";
  const initial = savedTimeZone ? snapshot(1, name, cron, savedTimeZone) : undefined;
  vi.spyOn(crypto, "randomUUID").mockReturnValue("66410000-0000-4000-8000-000000000010");
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      Response.json({ automation: snapshot(initial ? 2 : 1, name, cron, timeZone) }),
    );
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(
    <AutomationEditor
      workspaceId={fixtureId("009")}
      workspaceSlug="fixture"
      factoryId={fixtureId("008")}
      revisionSelected={false}
      initial={initial}
      setup={setup}
      setupFailed={false}
    />,
  );

  const input = screen.getByRole("combobox", { name: "Time zone" });
  expect(input).toHaveValue(savedTimeZone ?? "Etc/UTC");
  if (initial) {
    const publish = screen.getByRole("button", { name: "Publish and enable" });
    expect(publish).toBeEnabled();
    await user.click(input);
    await user.click(screen.getByRole("option", { name: timeZone }));
    expect(input).toHaveValue(timeZone);
    expect(input).toHaveFocus();
    expect(publish).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
  } else {
    await user.type(screen.getByRole("textbox", { name: "Rule name" }), name);
    await user.click(screen.getByRole("combobox", { name: "Assigned target" }));
    await user.click(screen.getByRole("option", { name: "Agent: Fixture reviewer" }));
    await user.clear(input);
    await user.type(input, timeZone);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
  }

  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    ...(initial
      ? { action: "save", expectedRevisionId: initial.draftRevisionId }
      : { automationId: fixtureId("010") }),
    definition: { trigger: { kind: "schedule", cron, timeZone } },
  });
});

it("retains a stale edit and uses the current revision only after explicit rebase", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({}, { status: 409 }))
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({ automation: snapshot(2, "Other manager edit", "0 14 * * *") }),
    )
    .mockResolvedValueOnce(
      Response.json({ automation: snapshot(3, "My retained edit", "0 14 * * *") }),
    );
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
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the current revision");
  expect(name).toHaveValue("My retained edit");
  expect(save).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Use latest revision and keep edits" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Both drafts changed");
  expect(save).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Keep my conflicting edits" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Revision 2 is current");
  expect(screen.getByRole("textbox", { name: "Rule name" })).toHaveValue("My retained edit");
  expect(fetch.mock.calls[2][1]?.method).toBeUndefined();

  await user.click(save);
  expect(await screen.findByRole("status")).toHaveTextContent("Draft revision 3 saved");
  expect(JSON.parse(String(fetch.mock.calls[3][1]?.body))).toMatchObject({
    action: "save",
    expectedRevisionId: fixtureId("012"),
    definition: { name: "My retained edit", trigger: { cron: "0 14 * * *" } },
  });
});

it("loads named Linear choices for an owner or admin after a rebase changes the trigger", async () => {
  const { user, fetch } = await rebaseToLinear(true);
  const state = screen.getByRole("combobox", { name: "Add Linear state" });
  await waitFor(() => expect(state).toBeEnabled());
  await user.click(state);
  expect(screen.getByRole("option", { name: "Done" })).toBeVisible();
  expect(screen.getByText("In review")).toBeVisible();
  const urls = fetch.mock.calls.map(([url]) => String(url));
  expect(urls).toContain(linearEndpoint);
  expect(urls).toContain(
    `${linearEndpoint}/catalog?provider=linear&kind=state&resourceId=${linearMappingId}`,
  );
});

it("keeps rebased Linear filters read-only for a factory-only manager without a lookup", async () => {
  const { fetch } = await rebaseToLinear(false);
  expect(screen.getByText(/Only workspace owners and admins can look up/)).toBeVisible();
  expect(screen.getByText("Saved Linear state · Unavailable in lookup")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Add Linear state" })).toBeDisabled();
  const form = screen.getByRole("textbox", { name: "Rule name" }).closest("form");
  expect(new FormData(form ?? undefined).get("stateIds")).toBe(savedStateId);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("saves retained edits to the rule created before its response was lost", async () => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("66410000-0000-4000-8000-000000000010");
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(Response.json({}, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ automation: snapshot(1, "First draft") }))
    .mockResolvedValueOnce(Response.json({ automation: snapshot(2, "Edited draft") }));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(
    <AutomationEditor
      workspaceId={fixtureId("009")}
      workspaceSlug="fixture"
      factoryId={fixtureId("008")}
      revisionSelected={false}
      setup={setup}
      setupFailed={false}
    />,
  );

  const name = screen.getByRole("textbox", { name: "Rule name" });
  const save = screen.getByRole("button", { name: "Save draft" });
  await user.type(name, "First draft");
  await user.click(screen.getByRole("combobox", { name: "Assigned target" }));
  await user.click(screen.getByRole("option", { name: "Agent: Fixture reviewer" }));
  await user.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("Your field values are still here");
  await user.clear(name);
  await user.type(name, "Edited draft");
  await user.click(save);

  expect(await screen.findByRole("status")).toHaveTextContent("Revision 1 is current");
  expect(screen.getByRole("textbox", { name: "Rule name" })).toHaveValue("Edited draft");
  await user.click(save);
  expect(await screen.findByRole("status")).toHaveTextContent("Draft revision 2 saved");
  for (const request of fetch.mock.calls.slice(0, 2)) {
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ automationId: fixtureId("010") });
  }
  expect(fetch.mock.calls[2][0]).toBe(fetch.mock.calls[3][0]);
  expect(JSON.parse(String(fetch.mock.calls[3][1]?.body))).toMatchObject({
    action: "save",
    expectedRevisionId: fixtureId("011"),
    definition: { name: "Edited draft" },
  });
});
