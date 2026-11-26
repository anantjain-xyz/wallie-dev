// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";

import { ConnectorResources, type ConnectorInstallation } from "./resources";
import { ConnectorSetup } from "./setup";
import { SlackConnectorAccess } from "./slack-access";

const workspaceId = "67600000-0000-4000-8000-000000000001";
const factoryId = "67600000-0000-4000-8000-000000000002";
const installationId = "67600000-0000-4000-8000-000000000003";
const linkId = "67600000-0000-4000-8000-000000000004";
const resourceId = "67600000-0000-4000-8000-000000000005";
const teamId = "T12345";
const channelId = "C12345";
const connectorEndpoint = `/api/workspaces/${workspaceId}/factories/${factoryId}/connectors`;
const slackEndpoint = `${connectorEndpoint}/slack`;

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("connector=slack&slackResult=linked"),
}));

const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const installation = {
  id: installationId,
  teamId,
  teamName: "Fixture Slack",
  generation: 7,
  status: "connected",
  grantedScopes: ["channels:read"],
  missingScopes: [],
  linkedActor: null,
};
const otherInstallation = {
  ...installation,
  id: "67600000-0000-4000-8000-000000000006",
  teamId: "T67890",
  teamName: "Other Slack",
  generation: 9,
};

beforeEach(() => {
  request.mockReset();
  vi.stubGlobal("fetch", request);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function postedCommands() {
  return request.mock.calls.flatMap(([url, init]) =>
    init?.method === "POST" ? [{ url, body: JSON.parse(String(init.body)) }] : [],
  );
}

it("lets a visible factory member start self-linking without loading management inventory", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({ configured: true, canConfigure: false, installations: [installation] }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: "Slack authorization expired." }, { status: 409 }),
    );
  const user = userEvent.setup();
  render(
    <ConnectorResources
      canManage={false}
      factoryId={factoryId}
      workspaceId={workspaceId}
      workspaceSlug="fixture"
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Link my Slack account" }));

  expect(request.mock.calls.map(([url]) => url)).toEqual([slackEndpoint, slackEndpoint]);
  expect(postedCommands()).toEqual([
    { url: slackEndpoint, body: { action: "link", installationId, expectedGeneration: 7 } },
  ]);
  expect(screen.queryByRole("button", { name: "Connect Slack" })).toBeNull();
  expect(screen.queryByText(/Granted Slack permissions/)).toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent("Slack authorization expired.");
});

it("shows granted and missing Slack permissions to a factory manager", async () => {
  request.mockResolvedValueOnce(
    Response.json({
      configured: true,
      canConfigure: false,
      installations: [{ ...installation, missingScopes: ["chat:write"] }],
    }),
  );
  render(<SlackConnectorAccess canManage endpoint={connectorEndpoint} result={null} />);

  expect(await screen.findByText("Granted Slack permissions channels:read")).toBeVisible();
  expect(screen.getByText("Missing Slack permissions chat:write")).toBeVisible();
});

it("drops stale Slack access after disconnect and reconnects with the current generation", async () => {
  let disconnected = false;
  request.mockImplementation(async (url, init) => {
    const generation = disconnected ? 8 : 7;
    const status = disconnected ? "disconnected" : "connected";
    if (url === connectorEndpoint)
      return Response.json({
        canConfigure: true,
        resources: [],
        installations: [
          {
            id: installationId,
            provider: "slack",
            externalTenantId: teamId,
            externalInstallationId: teamId,
            generation,
            status,
          },
        ],
      });
    if (url === `${connectorEndpoint}/setup`) {
      disconnected = true;
      return Response.json({ disconnected: true });
    }
    if (url === slackEndpoint && init?.method !== "POST")
      return Response.json({
        configured: true,
        canConfigure: true,
        installations: [{ ...installation, generation, status }],
      });
    return Response.json({ error: "Slack authorization expired." }, { status: 409 });
  });
  const user = userEvent.setup();
  render(
    <ConnectorResources
      canManage
      factoryId={factoryId}
      workspaceId={workspaceId}
      workspaceSlug="fixture"
    />,
    { wrapper: OverlayProvider },
  );
  expect(await screen.findByRole("button", { name: "Link my Slack account" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Disconnect connector" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Disconnect connector" }));

  expect(await screen.findByText("Slack workspace disconnected.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Link my Slack account" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Reconnect Slack" }));
  expect(postedCommands()).toEqual([
    {
      url: `${connectorEndpoint}/setup`,
      body: { action: "disconnect", installationId, expectedGeneration: 7 },
    },
    { url: slackEndpoint, body: { action: "install", teamId, expectedGeneration: 8 } },
  ]);
});

it("reconnects the named workspace directly and parses a new Slack web app link", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({ configured: true, canConfigure: true, installations: [installation] }),
    )
    .mockImplementation(async () =>
      Response.json({ error: "Slack authorization expired." }, { status: 409 }),
    );
  const user = userEvent.setup();
  render(<SlackConnectorAccess endpoint={connectorEndpoint} result={null} />);
  const reconnect = await screen.findByRole("button", { name: "Reconnect Slack" });
  await user.click(reconnect);
  await screen.findByRole("alert");

  const teamField = screen.getByRole("textbox", { name: "Slack workspace URL or ID" });
  expect(teamField).toHaveValue("");
  expect(screen.getByRole("button", { name: "Connect Slack" })).toBeDisabled();
  await user.type(teamField, "https://app.slack.com/client/T67890/C23456");
  expect(screen.getByText("Slack will confirm the name for workspace T67890.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Connect Slack" }));

  expect(postedCommands()).toEqual([
    { url: slackEndpoint, body: { action: "install", teamId, expectedGeneration: 7 } },
    {
      url: slackEndpoint,
      body: { action: "install", teamId: "T67890", expectedGeneration: 0 },
    },
  ]);
});

it("defaults to the connected Slack workspace and shows names and statuses in the picker", async () => {
  request.mockResolvedValueOnce(
    Response.json({
      configured: true,
      canConfigure: false,
      installations: [
        {
          ...otherInstallation,
          teamName: otherInstallation.teamId,
          status: "disconnected",
        },
        { ...installation, linkedActor: { id: linkId, userId: "U12345" } },
        {
          ...installation,
          id: "67600000-0000-4000-8000-000000000007",
          teamId: "T98765",
          teamName: "Restricted Slack",
          teamDomain: "restricted",
          status: "credential_unavailable",
        },
      ],
    }),
  );
  const user = userEvent.setup();
  render(<SlackConnectorAccess endpoint={connectorEndpoint} result={null} />);

  const workspace = await screen.findByRole("combobox", { name: "Slack workspace" });
  expect(workspace).toHaveTextContent("Fixture Slack · Connected");
  expect(screen.getByText("Slack account linked")).toBeVisible();
  expect(screen.getByText("U12345")).not.toBeVisible();

  workspace.focus();
  await user.keyboard("{Enter}");
  const listbox = await screen.findByRole("listbox");
  expect(
    within(listbox).getByRole("option", { name: "Fixture Slack · Connected", selected: true }),
  ).toBeInTheDocument();
  expect(
    within(listbox).getByRole("option", {
      name: "Restricted Slack · restricted · Access unavailable",
    }),
  ).toBeInTheDocument();
  await user.keyboard("{ArrowUp}{Escape}");
  expect(listbox).not.toBeInTheDocument();
  expect(workspace).toHaveFocus();
  expect(workspace).toHaveTextContent("Fixture Slack · Connected");

  await user.keyboard("{Enter}{ArrowUp}{Enter}");
  expect(workspace).toHaveFocus();
  expect(workspace).toHaveTextContent("Workspace name unavailable · Disconnected");
  expect(screen.getByText("Slack workspace disconnected.")).toBeVisible();
  expect(screen.getByText("T67890")).not.toBeVisible();
  await user.click(screen.getByText("Slack workspace ID"));
  expect(screen.getByText("T67890")).toBeVisible();
  expect(postedCommands()).toEqual([]);
});

it("clears the draft and notice only on a workspace change, then links the selected workspace on request", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({
        configured: true,
        canConfigure: true,
        installations: [installation, otherInstallation],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: "Slack authorization expired." }, { status: 409 }),
    );
  const user = userEvent.setup();
  render(<SlackConnectorAccess endpoint={connectorEndpoint} result="linked" />);

  const workspace = await screen.findByRole("combobox", { name: "Slack workspace" });
  const draft = screen.getByRole("textbox", { name: "Slack workspace URL or ID" });
  const notice = screen.getByText("Your Slack identity is linked.");
  await user.type(draft, "T98765");
  await user.click(workspace);
  await user.click(screen.getByRole("option", { name: "Fixture Slack · Connected" }));
  expect(draft).toHaveValue("T98765");
  expect(notice).toBeVisible();

  await user.click(workspace);
  await user.click(screen.getByRole("option", { name: "Other Slack · Connected" }));
  expect(workspace).toHaveTextContent("Other Slack · Connected");
  expect(draft).toHaveValue("");
  expect(notice).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect Slack" })).toBeDisabled();
  expect(postedCommands()).toEqual([]);

  await user.click(screen.getByRole("button", { name: "Link my Slack account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Slack authorization expired.");
  expect(postedCommands()).toEqual([
    {
      url: slackEndpoint,
      body: { action: "link", installationId: otherInstallation.id, expectedGeneration: 9 },
    },
  ]);
});

it("confirms removal of the selected workspace's identity link and refreshes just the Slack summary", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({
        configured: true,
        canConfigure: false,
        installations: [
          installation,
          { ...otherInstallation, linkedActor: { id: linkId, userId: "U12345" } },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ revoked: true }))
    .mockResolvedValueOnce(
      Response.json({ configured: true, canConfigure: false, installations: [installation] }),
    );
  const user = userEvent.setup();
  render(<SlackConnectorAccess endpoint={connectorEndpoint} result={null} />, {
    wrapper: OverlayProvider,
  });
  await user.click(await screen.findByRole("combobox", { name: "Slack workspace" }));
  await user.click(screen.getByRole("option", { name: "Other Slack · Connected" }));
  expect(postedCommands()).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Remove Slack identity link" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(postedCommands()).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "Remove identity link" }));

  expect(await screen.findByRole("button", { name: "Link my Slack account" })).toBeEnabled();
  expect(postedCommands()).toEqual([
    {
      url: slackEndpoint,
      body: { action: "revoke", installationId: otherInstallation.id, linkId },
    },
  ]);
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    slackEndpoint,
    slackEndpoint,
    slackEndpoint,
  ]);
});

it("maps the selected Slack channel under the exact installed tenant", async () => {
  const selectedInstallation: ConnectorInstallation = {
    id: installationId,
    provider: "slack",
    status: "connected",
    generation: 7,
    externalTenantId: teamId,
    externalInstallationId: teamId,
  };
  request
    .mockResolvedValueOnce(
      Response.json({
        provider: "slack",
        kind: "channel",
        tenant: { id: teamId, label: "Fixture Slack" },
        resources: [{ id: "C67890", label: "#fixture", description: "Fixture channel" }],
        nextCursor: "next-page",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        provider: "slack",
        kind: "channel",
        tenant: { id: teamId, label: "Fixture Slack" },
        resources: [{ id: channelId, label: "#on-call" }],
        nextCursor: null,
      }),
    )
    .mockResolvedValueOnce(Response.json({ resourceId, mappingRevision: 1 }));
  const onChanged = vi.fn();
  const user = userEvent.setup();
  render(
    <ConnectorSetup
      disabled={false}
      endpoint={connectorEndpoint}
      installation={selectedInstallation}
      installations={[selectedInstallation]}
      onChanged={onChanged}
      provider="slack"
      resources={[]}
    />,
    { wrapper: OverlayProvider },
  );

  await user.click(screen.getByRole("button", { name: "Find Slack channels" }));
  const picker = await screen.findByRole("combobox", { name: "Slack channel to map" });
  const map = screen.getByRole("button", { name: "Map to factory" });
  expect(picker).toHaveTextContent("Choose an option");
  expect(map).toBeDisabled();
  await user.tab();
  expect(picker).toHaveFocus();
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(picker).toHaveFocus();
  expect(picker).toHaveTextContent("#fixture · Fixture channel");
  expect(map).toBeEnabled();

  await user.click(screen.getByRole("button", { name: "Load more options" }));
  await user.click(picker);
  expect(
    screen.getByRole("option", { name: "#fixture · Fixture channel", selected: true }),
  ).toBeVisible();
  expect(screen.getByRole("option", { name: "#on-call" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(picker).toHaveFocus();
  expect(picker).toHaveTextContent("#fixture · Fixture channel");
  await user.click(picker);
  await user.click(screen.getByRole("option", { name: "Choose an option" }));
  expect(map).toBeDisabled();
  await user.click(picker);
  await user.click(screen.getByRole("option", { name: "#on-call" }));
  expect(postedCommands()).toEqual([]);
  await user.click(map);

  const catalog = `${connectorEndpoint}/catalog?provider=slack&kind=channel&installationId=${installationId}`;
  expect(request).toHaveBeenNthCalledWith(1, catalog);
  expect(request).toHaveBeenNthCalledWith(2, `${catalog}&cursor=next-page`);
  expect(postedCommands()).toEqual([
    {
      url: `${connectorEndpoint}/setup`,
      body: {
        action: "map",
        installationId,
        expectedGeneration: 7,
        expectedMappingRevision: 0,
        resource: { kind: "channel", id: channelId },
      },
    },
  ]);
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(resourceId));
});
