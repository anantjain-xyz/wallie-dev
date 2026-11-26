// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";

import { ConnectorResources, type ConnectorResource } from "./resources";

const workspaceId = "67600000-0000-4000-8000-000000000001";
const factoryId = "67600000-0000-4000-8000-000000000002";
const endpoint = `/api/workspaces/${workspaceId}/factories/${factoryId}/connectors`;
const emptyInventory = { canConfigure: false, installations: [], resources: [] };
const emptyDeliveries = { deliveries: [], nextCursor: null, linearDiscovery: null };
const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let query = "";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query),
}));

beforeEach(() => {
  query = "";
  request.mockReset();
  vi.stubGlobal("fetch", request);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderResources() {
  render(
    <ConnectorResources
      canManage
      factoryId={factoryId}
      workspaceId={workspaceId}
      workspaceSlug="fixture"
    />,
    { wrapper: OverlayProvider },
  );
  return screen.getByRole("combobox", { name: /^Provider$/ });
}

it("keeps Provider disabled until connector inventory loads successfully", async () => {
  const inventory = Promise.withResolvers<Response>();
  request
    .mockReturnValueOnce(inventory.promise)
    .mockResolvedValueOnce(Response.json(emptyInventory));
  const user = userEvent.setup();
  const provider = renderResources();

  expect(provider).toBeDisabled();
  expect(provider).toHaveTextContent("GitHub");
  expect(screen.getByText("Loading connector resources…")).toHaveAttribute("role", "status");
  await user.click(provider);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

  inventory.resolve(Response.json({}, { status: 500 }));
  expect(await screen.findByText("Connector resources are unavailable.")).toHaveAttribute(
    "role",
    "alert",
  );
  expect(provider).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Reload resources" }));
  expect(await screen.findByText("No GitHub resources mapped to this factory.")).toBeVisible();
  expect(provider).toBeEnabled();
});

it("starts on Slack after OAuth and switches provider panels without mutating connections", async () => {
  query = "connector=slack&slackResult=linked";
  request
    .mockResolvedValueOnce(Response.json({ ...emptyInventory, canConfigure: true }))
    .mockResolvedValueOnce(
      Response.json({ configured: true, canConfigure: true, installations: [] }),
    );
  const user = userEvent.setup();
  const provider = renderResources();

  expect(await screen.findByText("Your Slack identity is linked.")).toBeVisible();
  expect(provider).toHaveTextContent("Slack");
  const slackSetup = screen.getByRole("heading", { name: "Connector setup" });

  await user.tab();
  expect(provider).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  const options = within(screen.getByRole("listbox"));
  expect(options.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "GitHub",
    "Linear",
    "Slack",
  ]);
  expect(options.getByRole("option", { name: "Slack", selected: true })).toBeVisible();
  await user.keyboard("{Home}{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(provider).toHaveFocus();
  expect(provider).toHaveTextContent("Slack");

  await user.keyboard("{Enter}{ArrowUp}{Enter}");
  expect(provider).toHaveTextContent("Linear");
  expect(provider).toHaveFocus();
  expect(screen.getByText("No Linear resources mapped to this factory.")).toBeVisible();
  expect(slackSetup).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Connector setup" })).toBeVisible();

  await user.click(provider);
  await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "GitHub" }));
  expect(provider).toHaveTextContent("GitHub");
  expect(screen.getByText("No GitHub resources mapped to this factory.")).toBeVisible();
  expect(request.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
    [endpoint, "GET"],
    [`${endpoint}/slack`, "GET"],
  ]);
});

it("keeps disabled mappings inspectable, caches verified names and resets resource history", async () => {
  const team = {
    id: "67600000-0000-4000-8000-000000000003",
    installationId: "67600000-0000-4000-8000-000000000004",
    provider: "linear",
    kind: "team",
    externalId: "platform",
    label: null,
    mappingRevision: 1,
    enabled: true,
    connectionStatus: "connected",
    githubRequests: [],
  } satisfies ConnectorResource;
  const archivedTeam = {
    ...team,
    id: "67600000-0000-4000-8000-000000000005",
    externalId: "archive",
    label: "Archived team",
    enabled: false,
  };
  request.mockImplementation(async (url) => {
    if (url === endpoint) {
      return Response.json({
        ...emptyInventory,
        canConfigure: true,
        resources: [team, archivedTeam],
      });
    }
    if (url === `${endpoint}/catalog?provider=linear&kind=resource&resourceId=${team.id}`) {
      return Response.json({
        provider: "linear",
        kind: "resource",
        tenant: { id: "fixture-org", label: "Fixture organization" },
        resources: [{ id: team.externalId, label: "Platform team" }],
        nextCursor: null,
      });
    }
    return Response.json(emptyDeliveries);
  });
  const user = userEvent.setup();
  const provider = renderResources();
  await screen.findByText("No GitHub resources mapped to this factory.");
  await user.click(provider);
  await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Linear" }));

  const picker = screen.getByRole("combobox", { name: "Provider resource" });
  expect(await screen.findByText("Platform team")).toBeVisible();
  expect(picker).toHaveAttribute("data-value", team.id);
  const direction = screen.getByRole("combobox", { name: "Direction" });
  await user.click(direction);
  await user.click(
    within(screen.getByRole("listbox", { name: "Direction" })).getByRole("option", {
      name: "Ingress",
    }),
  );
  expect(request).toHaveBeenCalledWith(
    `${endpoint}/${team.id}/deliveries?lane=ingress`,
    expect.anything(),
  );
  picker.focus();
  await user.keyboard("{Enter}");
  const options = within(screen.getByRole("listbox", { name: "Provider resource" }));
  expect(options.getByRole("option", { name: "Platform team", selected: true })).toHaveFocus();
  await user.keyboard("{ArrowDown}{Escape}");
  expect(picker).toHaveFocus();
  expect(picker).toHaveAttribute("data-value", team.id);
  expect(direction).toHaveTextContent(/^Ingress$/);

  await user.keyboard("{Enter}{ArrowDown}{Enter}");
  expect(picker).toHaveFocus();
  expect(picker).toHaveAttribute("data-value", archivedTeam.id);
  expect(picker).toHaveTextContent("Archived team (disabled)");
  expect(screen.getByText(/Mapping disabled/)).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Direction" })).toHaveTextContent(/^All deliveries$/);
  expect(request).toHaveBeenCalledWith(
    `${endpoint}/${archivedTeam.id}/deliveries?lane=all`,
    expect.anything(),
  );

  await user.click(picker);
  const updatedOptions = within(screen.getByRole("listbox", { name: "Provider resource" }));
  expect(
    updatedOptions.getByRole("option", { name: "Archived team (disabled)", selected: true }),
  ).toBeVisible();
  expect(updatedOptions.getByRole("option", { name: "Platform team" })).toBeVisible();
});

it("only lists Slack mappings in the selected installation", async () => {
  query = "connector=slack";
  const [north, south, archive] = ["T12345", "T54321", "T67890"].map((teamId, index) => ({
    id: `67600000-0000-4000-8000-00000000001${index}`,
    provider: "slack",
    generation: index + 1,
    status: index === 2 ? "disconnected" : "connected",
    externalTenantId: teamId,
    externalInstallationId: teamId,
  }));
  const resources = ["North alerts", null, "South alerts"].map((label, index) => ({
    id: `67600000-0000-4000-8000-00000000002${index}`,
    installationId: index === 2 ? south.id : north.id,
    provider: "slack",
    kind: "channel",
    externalId: `C1234${index}`,
    label,
    mappingRevision: 1,
    enabled: true,
    connectionStatus: "connected",
    githubRequests: [],
  }));
  const slack = Promise.withResolvers<Response>();
  let verificationCount = 0;
  request.mockImplementation(async (url, init) => {
    if (url === endpoint) {
      return Response.json({
        canConfigure: true,
        installations: [south, north, archive],
        resources,
      });
    }
    if (init?.method === "POST") {
      const error = url.endsWith("/slack") ? "Fixture link failed." : "Fixture disconnect failed.";
      return Response.json({ error }, { status: 409 });
    }
    if (url === `${endpoint}/slack`) return slack.promise;
    if (url === `${endpoint}/catalog?provider=slack&kind=resource&resourceId=${resources[1].id}`) {
      if (verificationCount++ > 0) return Response.json({}, { status: 503 });
      return Response.json({
        provider: "slack",
        kind: "resource",
        tenant: { id: north.externalTenantId, label: "Fixture North" },
        resources: [{ id: resources[1].externalId, label: "North triage" }],
        nextCursor: null,
      });
    }
    const installation = [north, south].find(
      (item) => url === `${endpoint}/catalog?provider=slack&kind=channel&installationId=${item.id}`,
    );
    if (installation) {
      return Response.json({
        provider: "slack",
        kind: "channel",
        tenant: {
          id: installation.externalTenantId,
          label: installation === north ? "Fixture North" : "Fixture South",
        },
        resources: [{ id: "C99999", label: "A channel to map" }],
        nextCursor: null,
      });
    }
    return Response.json(emptyDeliveries);
  });
  const user = userEvent.setup();
  renderResources();

  const picker = await screen.findByRole("combobox", { name: "Provider resource" });
  const workspace = screen.getByRole("combobox", { name: "Slack workspace" });
  expect(workspace).toHaveAttribute("data-value", north.id);
  expect(workspace).toHaveTextContent("Loading Slack workspace… · Connected");
  slack.resolve(
    Response.json({
      configured: true,
      canConfigure: false,
      installations: [north, south].map((item) => ({
        id: item.id,
        teamId: item.externalTenantId,
        teamName: item === north ? "Fixture North" : "Fixture South",
        ...(item === north ? { teamDomain: "fixture-north" } : {}),
        generation: item.generation,
        status: item.status,
        grantedScopes: ["channels:read"],
        missingScopes: [],
        linkedActor: null,
      })),
    }),
  );
  expect(await screen.findByText("Fixture North · fixture-north · Connected")).toBeVisible();
  await user.click(picker);
  const options = within(screen.getByRole("listbox", { name: "Provider resource" }));
  expect(options.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "North alerts",
    "Unnamed Slack channel mapping",
  ]);
  await user.click(options.getByRole("option", { name: "Unnamed Slack channel mapping" }));
  expect(picker).toHaveAttribute("data-value", resources[1].id);
  expect(await screen.findByText("North triage")).toBeVisible();
  const findChannels = () => screen.getByRole("button", { name: "Find Slack channels" });
  await user.click(findChannels());
  expect(await screen.findByRole("combobox", { name: "Slack channel to map" })).toBeVisible();
  const direction = () => screen.getByRole("combobox", { name: "Direction" });
  await user.click(direction());
  await user.click(screen.getByRole("option", { name: "Ingress" }));
  expect(direction()).toHaveAttribute("data-value", "ingress");

  workspace.focus();
  await user.keyboard("{Enter}");
  const workspaces = within(screen.getByRole("listbox", { name: "Slack workspace" }));
  expect(
    workspaces.getByRole("option", {
      name: "Fixture North · fixture-north · Connected",
      selected: true,
    }),
  ).toHaveFocus();
  expect(
    workspaces.getByRole("option", { name: "Workspace name unavailable · Disconnected" }),
  ).toHaveAttribute("data-value", archive.id);
  await user.keyboard("{ArrowUp}{Escape}");
  expect(workspace).toHaveFocus();
  expect(workspace).toHaveAttribute("data-value", north.id);
  expect(direction()).toHaveAttribute("data-value", "ingress");

  await user.keyboard("{Enter}{ArrowUp}{Enter}");
  expect(workspace).toHaveFocus();
  expect(workspace).toHaveAttribute("data-value", south.id);
  expect(picker).toHaveAttribute("data-value", resources[2].id);
  expect(direction()).toHaveAttribute("data-value", "all");
  expect(request).toHaveBeenCalledWith(
    `${endpoint}/${resources[2].id}/deliveries?lane=all`,
    expect.anything(),
  );
  expect(screen.queryByRole("combobox", { name: "Slack channel to map" })).not.toBeInTheDocument();
  await user.click(picker);
  const southOptions = within(screen.getByRole("listbox", { name: "Provider resource" }));
  expect(southOptions.getAllByRole("option")).toHaveLength(1);
  await user.click(southOptions.getByRole("option", { name: "South alerts", selected: true }));

  await user.click(findChannels());
  expect(await screen.findByRole("combobox", { name: "Slack channel to map" })).toBeVisible();
  const catalogQueries = request.mock.calls
    .filter(([url]) => url.startsWith(`${endpoint}/catalog?provider=slack&kind=channel`))
    .map(([url]) => new URL(url, "https://wallie.test").searchParams.get("installationId"));
  expect(catalogQueries).toEqual([north.id, south.id]);
  const commands = () =>
    request.mock.calls.flatMap(([url, init]) =>
      init?.method === "POST" ? [{ url, body: JSON.parse(String(init.body)) }] : [],
    );
  expect(commands()).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Link my Slack account" }));
  expect(await screen.findByText("Fixture link failed.")).toHaveAttribute("role", "alert");
  await user.click(screen.getByRole("button", { name: "Disconnect connector" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Disconnect connector" }),
  );
  const dialog = screen.getByRole("alertdialog");
  expect(await within(dialog).findByText("Fixture disconnect failed.")).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(commands()).toEqual([
    {
      url: `${endpoint}/slack`,
      body: { action: "link", installationId: south.id, expectedGeneration: south.generation },
    },
    {
      url: `${endpoint}/setup`,
      body: {
        action: "disconnect",
        installationId: south.id,
        expectedGeneration: south.generation,
      },
    },
  ]);

  await user.click(workspace);
  await user.click(
    within(screen.getByRole("listbox", { name: "Slack workspace" })).getByRole("option", {
      name: "Fixture North · fixture-north · Connected",
    }),
  );
  expect(picker).toHaveAttribute("data-value", resources[1].id);
  expect(
    await screen.findByText("Could not load mapped resource name for this resource."),
  ).toBeVisible();
  expect(picker).toHaveTextContent("North triage");
  expect(screen.queryByText("Fixture link failed.")).not.toBeInTheDocument();
});
