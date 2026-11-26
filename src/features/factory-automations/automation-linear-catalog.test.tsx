// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { AutomationLinearCatalog } from "./automation-linear-catalog";
import { AutomationLinearFilter, AutomationLinearSample } from "./automation-resource-fields";

const endpoint = "/api/example/connectors";
const mappingId = "66410000-0000-4000-8000-000000000101";
const installationId = "66410000-0000-4000-8000-000000000102";
const tenantId = "66410000-0000-4000-8000-000000000103";
const teamId = "66410000-0000-4000-8000-000000000104";
const stateId = "66410000-0000-4000-8000-000000000105";
const projectId = "66410000-0000-4000-8000-000000000106";
const legacyState = "previously-saved-state";
const inventory = {
  canConfigure: true,
  installations: [
    {
      id: installationId,
      provider: "linear",
      generation: 2,
      status: "connected",
      externalTenantId: tenantId,
      externalInstallationId: tenantId,
    },
  ],
  resources: [
    {
      id: mappingId,
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
};

function fields(canDiscover: boolean) {
  const changed = vi.fn();
  render(
    <AutomationLinearCatalog
      canDiscover={canDiscover}
      endpoint={endpoint}
      integrationsHref="/settings?category=integrations"
      revisionUsesLinear
      savedIds={{ state: [legacyState], team: [teamId], project: [] }}
    >
      <form aria-label="Catalog selection">
        <AutomationLinearFilter
          kind="state"
          initial={[legacyState]}
          changed={changed}
          disabled={false}
        />
        <AutomationLinearSample kind="project" initial={null} changed={changed} disabled={false} />
        <AutomationLinearSample kind="team" initial={teamId} changed={changed} disabled={false} />
      </form>
    </AutomationLinearCatalog>,
  );
  const form = screen.getByRole("form", { name: "Catalog selection" });
  if (!(form instanceof HTMLFormElement)) throw new Error("Missing catalog form");
  return () => new FormData(form);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps saved values and never calls the credential-backed catalog for a factory-only manager", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const values = fields(false);
  expect(screen.getByText(/Ask one to configure the filters/)).toBeVisible();
  expect(screen.getByText("Saved Linear state · Unavailable in lookup")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Add Linear state" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Sample project" })).toHaveTextContent("No project");
  expect(values().get("stateIds")).toBe(legacyState);
  expect(values().get("teamId")).toBe(teamId);
  expect(fetch).not.toHaveBeenCalled();
});

it("retries scoped lookups and serializes selected provider IDs without dropping a missing state", async () => {
  let stateRequests = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input), "https://wallie.test");
    if (url.pathname === endpoint) return Response.json(inventory);
    const kind = url.searchParams.get("kind");
    if (kind === "state" && stateRequests++ === 0) return Response.json({}, { status: 502 });
    return Response.json({
      provider: "linear",
      kind,
      tenant: { id: tenantId, label: "Example workspace" },
      resources:
        kind === "team"
          ? [{ id: teamId, label: "Engineering", description: "ENG" }]
          : kind === "project"
            ? [{ id: projectId, label: "Onboarding" }]
            : [
                {
                  id: stateId,
                  label: "Done",
                  description: "Engineering (ENG) · completed",
                  teamId,
                },
              ],
      nextCursor: null,
    });
  });
  vi.stubGlobal("fetch", fetch);
  const values = fields(true);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Retry Linear states lookup" }));
  const state = screen.getByRole("combobox", { name: "Add Linear state" });
  await waitFor(() => expect(state).toBeEnabled());
  await user.click(state);
  await user.click(screen.getByRole("option", { name: "Done · Engineering (ENG) · completed" }));
  expect(values().get("stateIds")).toBe(`${legacyState}\n${stateId}`);
  expect(screen.getByText("Saved Linear state · Unavailable in lookup")).toBeVisible();

  await user.click(screen.getByRole("combobox", { name: "Sample team" }));
  await user.click(screen.getByRole("option", { name: "No team" }));
  expect(values().get("teamId")).toBe("");
  await user.click(screen.getByRole("combobox", { name: "Sample project" }));
  await user.click(screen.getByRole("option", { name: "Onboarding · Example workspace" }));
  expect(values().get("projectId")).toBe(projectId);

  const urls = fetch.mock.calls.map(([url]) => String(url));
  expect(urls).toContain(`${endpoint}/catalog?provider=linear&kind=state&resourceId=${mappingId}`);
  expect(urls).toContain(`${endpoint}/catalog?provider=linear&kind=team&resourceId=${mappingId}`);
  expect(urls).toContain(`${endpoint}/catalog?provider=linear&kind=project`);
});
