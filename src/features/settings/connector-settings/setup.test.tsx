// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";

import type { ConnectorInstallation } from "./resources";
import { ConnectorSetup } from "./setup";

const endpoint = "/api/fixture/connectors";
const installation: ConnectorInstallation = {
  id: "68500000-0000-4000-8000-000000000001",
  provider: "linear",
  status: "connected",
  generation: 7,
  externalTenantId: "fixture-linear",
  externalInstallationId: "fixture-linear",
};
const teamId = "68500000-0000-4000-8000-000000000002";
const projectId = "68500000-0000-4000-8000-000000000003";
const resourceId = "68500000-0000-4000-8000-000000000004";

function catalog(kind: "team" | "project", id: string, label: string) {
  return Response.json({
    provider: "linear",
    kind,
    tenant: { id: installation.externalTenantId, label: "Fixture Linear" },
    resources: [{ id, label }],
    nextCursor: null,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("scopes Linear lookups and resets the mapping choice when resource type changes", async () => {
  const pendingMap = Promise.withResolvers<Response>();
  const request = vi
    .fn<(url: string, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(catalog("team", teamId, "Fixture team"))
    .mockResolvedValueOnce(catalog("project", projectId, "Fixture project"))
    .mockReturnValueOnce(pendingMap.promise);
  vi.stubGlobal("fetch", request);
  const onChanged = vi.fn();
  const user = userEvent.setup();
  render(
    <ConnectorSetup
      disabled={false}
      endpoint={endpoint}
      installations={[installation]}
      onChanged={onChanged}
      provider="linear"
      resources={[]}
    />,
    { wrapper: OverlayProvider },
  );

  const kind = screen.getByRole("combobox", { name: "Resource type" });
  const find = () => screen.getByRole("button", { name: "Find provider resources" });
  expect(kind).toHaveTextContent("Team");
  await user.click(find());
  expect(request).toHaveBeenNthCalledWith(1, `${endpoint}/catalog?provider=linear&kind=team`);
  const team = await screen.findByRole("combobox", { name: "Resource to map" });
  await user.click(team);
  await user.click(screen.getByRole("option", { name: "Fixture team" }));
  expect(screen.getByRole("button", { name: "Map to factory" })).toBeEnabled();

  await user.click(kind);
  expect(screen.getByRole("listbox", { name: "Resource type" })).toBeVisible();
  expect(screen.getByRole("option", { name: "Team", selected: true })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(kind).toHaveFocus();
  expect(team).toHaveTextContent("Fixture team");
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(kind).toHaveTextContent("Project");
  expect(kind).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Resource to map")).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);

  await user.click(find());
  expect(request).toHaveBeenNthCalledWith(2, `${endpoint}/catalog?provider=linear&kind=project`);
  const project = await screen.findByRole("combobox", { name: "Resource to map" });
  const map = screen.getByRole("button", { name: "Map to factory" });
  expect(project).toHaveTextContent("Choose an option");
  expect(map).toBeDisabled();
  await user.click(project);
  await user.click(screen.getByRole("option", { name: "Fixture project" }));
  await user.click(map);
  expect(project).toBeDisabled();
  expect(kind).toBeDisabled();
  expect(request).toHaveBeenCalledTimes(3);
  const [url, init] = request.mock.calls[2];
  expect(url).toBe(`${endpoint}/setup`);
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({
    action: "map",
    installationId: installation.id,
    expectedGeneration: 7,
    expectedMappingRevision: 0,
    resource: { kind: "project", id: projectId },
  });

  pendingMap.resolve(Response.json({ resourceId, mappingRevision: 1 }));
  expect(await screen.findByText("Resource mapped to this factory.")).toBeVisible();
  expect(onChanged).toHaveBeenCalledWith(resourceId);
  expect(kind).toBeEnabled();
  expect(kind).toHaveTextContent("Project");
});

it("resets verified GitHub catalog choices and opens existing mappings by their mapped ID", async () => {
  const githubInstallation: ConnectorInstallation = {
    ...installation,
    provider: "github",
    externalTenantId: "8421",
    externalInstallationId: "4211",
  };
  const repositoryId = "68500000-0000-4000-8000-000000000005";
  const githubCatalog = {
    provider: "github",
    kind: "repository",
    tenant: { id: githubInstallation.externalTenantId, label: "Fixture GitHub" },
    resources: [
      {
        id: repositoryId,
        externalId: "4321",
        label: "fixture/repository",
      },
    ],
    nextCursor: null,
  };
  const otherInstallation: ConnectorInstallation = {
    ...githubInstallation,
    id: "68500000-0000-4000-8000-000000000006",
    externalTenantId: "8422",
    externalInstallationId: "4212",
  };
  const otherCatalog = {
    ...githubCatalog,
    tenant: { id: otherInstallation.externalTenantId, label: "Other fixture GitHub" },
    resources: [
      {
        id: "68500000-0000-4000-8000-000000000007",
        externalId: "4322",
        label: "other/repository",
      },
    ],
  };
  const request = vi
    .fn<(url: string, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(
      Response.json({ ...githubCatalog, tenant: { id: "9999", label: "Unconnected fixture" } }),
    )
    .mockResolvedValueOnce(Response.json({ ...githubCatalog, resources: [] }))
    .mockResolvedValueOnce(Response.json({ ...githubCatalog, nextCursor: repositoryId }))
    .mockResolvedValueOnce(Response.json(otherCatalog))
    .mockResolvedValueOnce(Response.json(otherCatalog));
  vi.stubGlobal("fetch", request);
  const onSelectMapped = vi.fn();
  const user = userEvent.setup();
  render(
    <ConnectorSetup
      disabled={false}
      endpoint={endpoint}
      installations={[githubInstallation, otherInstallation]}
      onChanged={vi.fn()}
      onSelectMapped={onSelectMapped}
      provider="github"
      resources={[
        {
          id: resourceId,
          installationId: githubInstallation.id,
          provider: "github",
          kind: "repository",
          externalId: "4321",
          label: "fixture/repository",
          mappingRevision: 4,
          enabled: true,
          connectionStatus: "connected",
          githubRequests: [],
        },
      ]}
    />,
    { wrapper: OverlayProvider },
  );

  const find = screen.getByRole("button", { name: "Find provider resources" });
  await user.click(find);
  expect(await screen.findByRole("button", { name: "Connect provider" })).toBeEnabled();
  expect(screen.queryByRole("combobox", { name: "Resource to map" })).not.toBeInTheDocument();
  await user.click(find);
  expect(await screen.findByText("No available options were returned.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Map to factory" })).toBeDisabled();

  await user.click(find);
  const picker = await screen.findByRole("combobox", { name: "Resource to map" });
  await user.click(picker);
  await user.click(screen.getByRole("option", { name: "fixture/repository" }));
  expect(onSelectMapped).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "View mapped resource" }));
  expect(onSelectMapped).toHaveBeenCalledExactlyOnceWith(resourceId, "fixture/repository");

  await user.click(screen.getByRole("button", { name: "Load more options" }));
  expect(picker).toHaveTextContent("Choose an option");
  expect(screen.getByRole("button", { name: "Map to factory" })).toBeDisabled();
  await user.click(picker);
  expect(screen.queryByRole("option", { name: "fixture/repository" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "other/repository" }));
  await user.click(find);
  expect(picker).toHaveTextContent("Choose an option");
  expect(screen.getByRole("button", { name: "Map to factory" })).toBeDisabled();
  const lookup = `${endpoint}/catalog?provider=github&kind=repository`;
  expect(request.mock.calls).toEqual([
    [lookup],
    [lookup],
    [lookup],
    [`${lookup}&cursor=${repositoryId}`],
    [lookup],
  ]);
});
