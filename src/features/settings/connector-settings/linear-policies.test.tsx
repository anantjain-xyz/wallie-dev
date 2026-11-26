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
const alternateTeam = { id: id(11), label: "Product", description: "PROD" };
const alternateStarting = {
  id: id(12),
  label: "In review",
  description: "Product (PROD) · started",
  teamId: alternateTeam.id,
};
const alternateEnding = {
  id: id(13),
  label: "Shipped",
  description: "Product (PROD) · completed",
  teamId: alternateTeam.id,
};
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

function fixture({ failLabels = false, savedState = starting.id, teams = [team] } = {}) {
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
    const states =
      query.get("teamId") === alternateTeam.id
        ? [alternateStarting, alternateEnding]
        : [starting, ending];
    return Response.json({
      provider: "linear",
      kind,
      tenant: { id: id(4), label: "Demo organization" },
      nextCursor: null,
      resources: kind === "team" ? teams : kind === "state" ? states : [label],
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
  const picker = screen.getByRole("combobox", { name: "Issue label (optional)" });
  expect(picker).not.toBeRequired();
  expect(picker).toHaveTextContent("Could not verify saved choice");
  expect(screen.getByText(label.id)).not.toBeVisible();
  await user.click(picker);
  const listbox = screen.getByRole("listbox", { name: "Issue label (optional)" });
  expect(
    within(listbox).getByRole("option", { name: "Could not verify saved choice", selected: true }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(within(listbox).getByRole("option", { name: "No label filter" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(picker).toHaveFocus();
  await user.keyboard("{ArrowDown}{Tab}");
  expect(listbox).not.toBeInTheDocument();
  expect(screen.getByText("Saved provider ID")).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "Save intake" }));
  expect(states).toHaveFocus();
  expect(writes).toEqual([]);

  await user.click(missing);
  await user.click(
    screen.getByRole("checkbox", { name: "In progress (Platform (PLAT) · started)" }),
  );
  await user.click(screen.getByRole("button", { name: "Save intake" }));
  expect(picker).toHaveFocus();
  expect(picker).toHaveAttribute("aria-invalid", "true");
  expect(picker).toHaveAccessibleDescription(
    "Choose an available issue label or remove the filter.",
  );
  expect(writes).toEqual([]);

  await user.click(screen.getByRole("button", { name: "Retry issue labels lookup" }));
  await within(picker).findByText("Wallie · Linear workspace label");
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

it("clears the label with the keyboard without resetting the workflow-state error", async () => {
  const writes = fixture({ failLabels: true, savedState: savedStateId });
  const user = userEvent.setup();
  render(
    <LinearConnectorPolicies factoryEndpoint={endpoint} onChanged={vi.fn()} resource={resource} />,
  );
  await user.click(screen.getByText("Linear routing and outcomes"));
  await screen.findByRole("button", { name: "Retry issue labels lookup" });
  const picker = screen.getByRole("combobox", { name: "Issue label (optional)" });
  const states = screen.getByRole("button", { name: "Workflow states 1 selected" });
  const save = screen.getByRole("button", { name: "Save intake" });
  await user.click(save);
  expect(states).toHaveFocus();
  expect(picker).toHaveAttribute("aria-invalid", "true");

  await user.tab();
  expect(picker).toHaveFocus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(picker).toHaveFocus();
  expect(picker).toHaveTextContent("No label filter");
  expect(picker).not.toHaveAttribute("aria-invalid");
  expect(states).toHaveAccessibleDescription(
    /Remove or replace choices that could not be verified/u,
  );
  expect(writes).toEqual([]);

  await user.click(states);
  await user.click(
    screen.getByRole("checkbox", { name: "Unavailable — choose a replacement (saved state 1)" }),
  );
  await user.click(
    screen.getByRole("checkbox", { name: "In progress (Platform (PLAT) · started)" }),
  );
  await user.click(save);
  await screen.findByText("Linear intake saved.");
  expect(writes).toEqual([
    {
      url: `${endpoint}/linear-discovery/${resource.id}`,
      command: {
        enabled: true,
        expectedRevision: 2,
        mappingRevision: 4,
        stateIds: [starting.id],
        serviceActorId: id(10),
      },
    },
  ]);
});

it("keeps the saved intake filters when disabling after changing the label draft", async () => {
  const writes = fixture();
  const user = userEvent.setup();
  render(
    <LinearConnectorPolicies factoryEndpoint={endpoint} onChanged={vi.fn()} resource={resource} />,
  );
  await user.click(screen.getByText("Linear routing and outcomes"));
  const picker = await screen.findByRole("combobox", { name: "Issue label (optional)" });
  await within(picker).findByText("Wallie · Linear workspace label");
  await user.click(picker);
  await user.click(screen.getByRole("option", { name: "No label filter" }));
  expect(picker).toHaveTextContent("No label filter");
  expect(writes).toEqual([]);

  await user.click(screen.getByRole("checkbox", { name: "Discover issues on this resource" }));
  await user.click(screen.getByRole("button", { name: "Save intake" }));
  await screen.findByText("Linear intake saved.");
  expect(writes).toEqual([
    {
      url: `${endpoint}/linear-discovery/${resource.id}`,
      command: {
        enabled: false,
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
  expect(teamChoice).toHaveAttribute("data-value", team.id);
  expect(teamChoice).toHaveTextContent("Platform · PLAT");
  for (const choice of [teamChoice, from, to]) expect(choice).toBeRequired();
  expect(fetchMock.mock.calls.some(([url]) => url.includes(`teamId=${team.id}`))).toBe(true);
  await user.selectOptions(from, starting.id);
  await user.selectOptions(to, starting.id);
  await user.click(screen.getByRole("button", { name: "Save outcomes" }));
  expect(to).toHaveFocus();
  expect(to).toHaveAccessibleDescription("Choose a different state from the starting state.");
  expect(writes).toEqual([]);

  await user.click(teamChoice);
  expect(screen.getByRole("option", { name: "Platform · PLAT", selected: true })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(teamChoice).toHaveFocus();
  expect(from).toHaveValue(starting.id);
  expect(to).toHaveValue(starting.id);
  expect(to).toHaveAccessibleDescription("Choose a different state from the starting state.");

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

it("validates the team on Save and resets the state choices and errors when the team changes", async () => {
  const writes = fixture({ teams: [team, alternateTeam] });
  const user = userEvent.setup();
  render(
    <LinearConnectorPolicies factoryEndpoint={endpoint} onChanged={vi.fn()} resource={resource} />,
  );
  await user.click(screen.getByText("Linear routing and outcomes"));
  await user.click(
    await screen.findByRole("checkbox", { name: "Change issue status after final approval" }),
  );

  const picker = screen.getByRole("combobox", { name: "Linear team" });
  const from = screen.getByRole("combobox", { name: "From state" });
  const to = screen.getByRole("combobox", { name: "To state" });
  const save = screen.getByRole("button", { name: "Save outcomes" });
  expect(picker).toBeRequired();
  expect(picker).toHaveTextContent("Choose a team");
  expect(picker).not.toHaveAttribute("aria-invalid");
  expect(picker.closest("form")?.checkValidity()).toBe(true);
  expect(from).toBeDisabled();
  expect(to).toBeDisabled();

  await user.click(save);
  expect(picker).toHaveFocus();
  expect(picker).toHaveAttribute("aria-invalid", "true");
  expect(picker).toHaveAccessibleDescription("Choose an available team on this project.");
  expect(writes).toEqual([]);

  await user.keyboard("{ArrowDown}");
  const listbox = screen.getByRole("listbox", { name: "Linear team" });
  await within(listbox).findByRole("option", { name: "Platform · PLAT" });
  await user.keyboard("{ArrowDown}{Enter}");
  expect(picker).toHaveFocus();
  expect(picker).toHaveAttribute("data-value", team.id);
  for (const choice of [picker, from, to]) expect(choice).not.toHaveAttribute("aria-invalid");
  await within(from).findByRole("option", { name: "In progress · Platform (PLAT) · started" });
  await user.selectOptions(from, starting.id);
  await user.selectOptions(to, starting.id);
  await user.click(save);
  expect(to).toHaveAccessibleDescription("Choose a different state from the starting state.");

  await user.click(picker);
  await user.keyboard("{Escape}");
  expect(picker).toHaveFocus();
  await user.keyboard("{ArrowDown}{Tab}");
  expect(from).toHaveFocus();
  await user.click(picker);
  await user.keyboard("{ArrowDown}{Enter}");
  expect(picker).toHaveAttribute("data-value", alternateTeam.id);
  expect(from).toHaveValue("");
  expect(to).toHaveValue("");
  expect(to).not.toHaveAttribute("aria-invalid");
  await within(from).findByRole("option", { name: "In review · Product (PROD) · started" });
  expect(within(from).queryByRole("option", { name: /In progress/u })).not.toBeInTheDocument();
  const stateScopes = fetchMock.mock.calls
    .map(([path]) => new URL(path, "https://wallie.test").searchParams)
    .filter((query) => query.get("kind") === "state" && query.has("teamId"))
    .map((query) => query.get("teamId"));
  expect(stateScopes).toEqual([team.id, alternateTeam.id]);
  expect(writes).toEqual([]);

  await user.click(save);
  expect(from).toHaveFocus();
  expect(from).toHaveAccessibleDescription("Choose an available starting state.");
  expect(writes).toEqual([]);
  await user.selectOptions(from, alternateStarting.id);
  await user.selectOptions(to, alternateEnding.id);
  await user.click(save);
  await screen.findByText("Linear outcomes saved.");
  expect(writes).toEqual([
    {
      url: `${endpoint}/linear-outbound/${resource.id}`,
      command: {
        commentsEnabled: true,
        expectedRevision: 2,
        mappingRevision: 4,
        statusMapping: {
          teamId: alternateTeam.id,
          fromStateId: alternateStarting.id,
          toStateId: alternateEnding.id,
        },
      },
    },
  ]);
});
