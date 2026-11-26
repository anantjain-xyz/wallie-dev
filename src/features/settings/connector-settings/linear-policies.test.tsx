// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LinearConnectorPolicies } from "./linear-policies";
import type { ConnectorResource } from "./resources";

function id(slot: number) {
  return `68300000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
}

const endpoint = "/api/workspaces/fixture/factories/fixture";
const team = { id: id(5), label: "Platform", description: "PLAT" };
const starting = {
  id: id(6),
  label: "In progress",
  description: "Platform (PLAT) · started",
  teamId: team.id,
};
const ending = {
  id: id(7),
  label: "Done",
  description: "Platform (PLAT) · completed",
  teamId: team.id,
};
const savedStateId = id(8);
const label = { id: id(9), label: "Wallie", description: "Linear workspace label" };
const resource: ConnectorResource = {
  id: id(1),
  installationId: id(2),
  provider: "linear",
  kind: "project",
  externalId: id(3),
  label: "Demo work",
  mappingRevision: 4,
  enabled: true,
  connectionStatus: "connected",
  githubRequests: [],
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture({ failLabels = false, savedState = starting.id } = {}) {
  let labelReads = 0;
  const writes: Array<{ url: string; command: unknown }> = [];
  fetchMock.mockImplementation(async (path, init) => {
    if (init?.method === "PUT") {
      writes.push({ url: path, command: JSON.parse(String(init.body)) });
      return Response.json({ revision: 3 });
    }
    if (path.includes("/linear-discovery/"))
      return Response.json({
        revision: 2,
        mappingRevision: 4,
        enabled: true,
        stateIds: [savedState],
        labelId: label.id,
        serviceActorId: id(10),
      });
    if (path.includes("/linear-outbound/"))
      return Response.json({
        revision: 2,
        mappingRevision: 4,
        commentsEnabled: true,
        statusMapping: null,
      });
    const query = new URL(path, "https://wallie.test").searchParams;
    expect(query.get("resourceId")).toBe(resource.id);
    const kind = query.get("kind");
    if (kind === "label" && ++labelReads === 1 && failLabels)
      return Response.json({ error: "Linear unavailable" }, { status: 502 });
    return Response.json({
      provider: "linear",
      kind,
      tenant: { id: id(4), label: "Demo organization" },
      nextCursor: null,
      resources: kind === "team" ? [team] : kind === "state" ? [starting, ending] : [label],
    });
  });
  return writes;
}

it("keeps an unavailable saved state and retries labels without losing the intake draft", async () => {
  const writes = fixture({ failLabels: true, savedState: savedStateId });
  const user = userEvent.setup();
  render(
    <LinearConnectorPolicies factoryEndpoint={endpoint} onChanged={vi.fn()} resource={resource} />,
  );
  await user.click(screen.getByText("Linear routing and outcomes"));

  const states = await screen.findByRole("button", { name: "Workflow states 1 selected" });
  await user.click(states);
  const missing = await screen.findByRole("checkbox", {
    name: "Unavailable — choose a replacement (saved state 1)",
  });
  expect(missing).toBeChecked();
  expect(screen.getByText(savedStateId)).not.toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load issue labels for this resource.",
  );
  await user.click(screen.getByRole("button", { name: "Save intake" }));
  expect(states).toHaveFocus();
  expect(writes).toEqual([]);

  await user.click(missing);
  await user.click(
    screen.getByRole("checkbox", { name: "In progress (Platform (PLAT) · started)" }),
  );
  await user.click(screen.getByRole("button", { name: "Retry issue labels lookup" }));
  const picker = screen.getByRole("combobox", { name: "Issue label (optional)" });
  await within(picker).findByRole("option", { name: "Wallie · Linear workspace label" });
  expect(picker).not.toBeRequired();
  expect(picker).toHaveValue(label.id);
  await user.click(screen.getByRole("button", { name: "Save intake" }));
  await screen.findByText("Linear intake saved.");
  expect(writes).toEqual([
    {
      url: `${endpoint}/linear-discovery/${resource.id}`,
      command: {
        enabled: true,
        expectedRevision: 2,
        mappingRevision: 4,
        stateIds: [starting.id],
        labelId: label.id,
        serviceActorId: id(10),
      },
    },
  ]);
});

it("preselects the sole project team and focuses the destination for a duplicate state", async () => {
  const writes = fixture();
  const user = userEvent.setup();
  render(
    <LinearConnectorPolicies factoryEndpoint={endpoint} onChanged={vi.fn()} resource={resource} />,
  );
  await user.click(screen.getByText("Linear routing and outcomes"));
  await user.click(
    await screen.findByRole("checkbox", { name: "Change issue status after final approval" }),
  );

  const from = screen.getByRole("combobox", { name: "From state" });
  const to = screen.getByRole("combobox", { name: "To state" });
  await within(from).findByRole("option", { name: "In progress · Platform (PLAT) · started" });
  const teamChoice = screen.getByRole("combobox", { name: "Linear team" });
  expect(teamChoice).toHaveValue(team.id);
  for (const choice of [teamChoice, from, to]) expect(choice).toBeRequired();
  expect(fetchMock.mock.calls.some(([url]) => url.includes(`teamId=${team.id}`))).toBe(true);
  await user.selectOptions(from, starting.id);
  await user.selectOptions(to, starting.id);
  await user.click(screen.getByRole("button", { name: "Save outcomes" }));
  expect(to).toHaveFocus();
  expect(to).toHaveAccessibleDescription("Choose a different state from the starting state.");
  expect(writes).toEqual([]);

  await user.selectOptions(to, ending.id);
  await user.click(screen.getByRole("button", { name: "Save outcomes" }));
  await screen.findByText("Linear outcomes saved.");
  expect(writes).toEqual([
    {
      url: `${endpoint}/linear-outbound/${resource.id}`,
      command: {
        commentsEnabled: true,
        expectedRevision: 2,
        mappingRevision: 4,
        statusMapping: { teamId: team.id, fromStateId: starting.id, toStateId: ending.id },
      },
    },
  ]);
});
