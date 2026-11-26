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

it("uses workspace names rather than IDs and puts unknown identities in details", async () => {
  request.mockResolvedValueOnce(
    Response.json({
      configured: true,
      canConfigure: false,
      installations: [
        { ...installation, linkedActor: { id: linkId, userId: "U12345" } },
        {
          ...installation,
          id: "67600000-0000-4000-8000-000000000006",
          teamId: "T67890",
          teamName: "T67890",
          status: "disconnected",
        },
      ],
    }),
  );
  const user = userEvent.setup();
  render(<SlackConnectorAccess endpoint={connectorEndpoint} result={null} />);

  const workspace = await screen.findByRole("combobox", { name: "Slack workspace" });
  expect(
    within(workspace).getByRole("option", { name: "Fixture Slack · Connected" }),
  ).toBeInTheDocument();
  expect(workspace).toHaveValue(installationId);
  expect(screen.getByText("Slack account linked")).toBeVisible();
  expect(screen.getByText("U12345")).not.toBeVisible();
  await user.selectOptions(
    workspace,
    within(workspace).getByRole("option", {
      name: "Workspace name unavailable · Disconnected",
    }),
  );
  await user.click(screen.getByText("Slack workspace ID"));
  expect(screen.getByText("T67890")).toBeVisible();
});

it("confirms removal of the current actor link and refreshes just the Slack summary", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({
        configured: true,
        canConfigure: false,
        installations: [{ ...installation, linkedActor: { id: linkId, userId: "U12345" } }],
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
  await user.click(await screen.findByRole("button", { name: "Remove Slack identity link" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(postedCommands()).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "Remove identity link" }));

  expect(await screen.findByRole("button", { name: "Link my Slack account" })).toBeEnabled();
  expect(postedCommands()).toEqual([
    { url: slackEndpoint, body: { action: "revoke", installationId, linkId } },
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
        resources: [{ id: channelId, label: "#fixture" }],
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
  );

  await user.click(screen.getByRole("button", { name: "Find Slack channels" }));
  await user.selectOptions(await screen.findByLabelText("Slack channel to map"), channelId);
  await user.click(screen.getByRole("button", { name: "Map to factory" }));

  const catalog = request.mock.calls[0]?.[0] ?? "";
  expect(Object.fromEntries(new URL(catalog, "https://wallie.test").searchParams)).toEqual({
    provider: "slack",
    kind: "channel",
    installationId,
  });
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
