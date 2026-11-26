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
  const installations = ["T12345", "T54321"].map((teamId, index) => ({
    id: `67600000-0000-4000-8000-00000000001${index}`,
    provider: "slack",
    generation: 1,
    status: "connected",
    externalTenantId: teamId,
    externalInstallationId: teamId,
  }));
  const resources = ["North alerts", "North triage", "South alerts"].map((label, index) => ({
    id: `67600000-0000-4000-8000-00000000002${index}`,
    installationId: installations[index === 2 ? 1 : 0].id,
    provider: "slack",
    kind: "channel",
    externalId: `C1234${index}`,
    label,
    mappingRevision: 1,
    enabled: true,
    connectionStatus: "connected",
    githubRequests: [],
  }));
  request.mockImplementation(async (url) => {
    if (url === endpoint) return Response.json({ ...emptyInventory, installations, resources });
    if (url === `${endpoint}/slack`) {
      return Response.json({
        configured: true,
        canConfigure: false,
        installations: installations.map((item, index) => ({
          id: item.id,
          teamId: item.externalTenantId,
          teamName: index === 0 ? "Fixture North" : "Fixture South",
          generation: item.generation,
          status: item.status,
          grantedScopes: ["channels:read"],
          missingScopes: [],
          linkedActor: null,
        })),
      });
    }
    return Response.json(emptyDeliveries);
  });
  const user = userEvent.setup();
  renderResources();

  const picker = await screen.findByRole("combobox", { name: "Provider resource" });
  const workspace = screen.getByRole("combobox", { name: "Slack workspace" });
  await user.click(picker);
  const options = within(screen.getByRole("listbox", { name: "Provider resource" }));
  expect(options.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "North alerts",
    "North triage",
  ]);
  await user.click(options.getByRole("option", { name: "North triage" }));
  expect(picker).toHaveAttribute("data-value", resources[1].id);

  await user.selectOptions(workspace, installations[1].id);
  expect(picker).toHaveAttribute("data-value", resources[2].id);
  await user.click(picker);
  const southOptions = within(screen.getByRole("listbox", { name: "Provider resource" }));
  expect(southOptions.getAllByRole("option")).toHaveLength(1);
  await user.click(southOptions.getByRole("option", { name: "South alerts", selected: true }));
  await user.selectOptions(workspace, installations[0].id);
  expect(picker).toHaveAttribute("data-value", resources[1].id);
});
