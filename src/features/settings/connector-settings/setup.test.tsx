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
  await user.selectOptions(await screen.findByLabelText("Resource to map"), teamId);
  expect(screen.getByRole("button", { name: "Map to factory" })).toBeEnabled();

  await user.click(kind);
  expect(screen.getByRole("listbox", { name: "Resource type" })).toBeVisible();
  expect(screen.getByRole("option", { name: "Team", selected: true })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(kind).toHaveFocus();
  expect(screen.getByLabelText("Resource to map")).toHaveValue(teamId);
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(kind).toHaveTextContent("Project");
  expect(kind).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Resource to map")).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);

  await user.click(find());
  expect(request).toHaveBeenNthCalledWith(2, `${endpoint}/catalog?provider=linear&kind=project`);
  const project = await screen.findByLabelText("Resource to map");
  const map = screen.getByRole("button", { name: "Map to factory" });
  expect(project).toHaveValue("");
  expect(map).toBeDisabled();
  await user.selectOptions(project, projectId);
  await user.click(map);
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
