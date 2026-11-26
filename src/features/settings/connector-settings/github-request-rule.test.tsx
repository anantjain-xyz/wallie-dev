// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { ConnectorResource } from "./resources";
import { GitHubRequestRule } from "./setup";

const resource: ConnectorResource = {
  id: "68500000-0000-4000-8000-000000000001",
  installationId: "68500000-0000-4000-8000-000000000002",
  provider: "github",
  kind: "repository",
  externalId: "84",
  label: "fixture-org/demo",
  mappingRevision: 3,
  enabled: true,
  connectionStatus: "connected",
  githubRequests: [{ enabled: true, revision: 2, sourceKind: "issue", labelId: 90 }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("finds the saved repository label beyond the first page and preselects its exact ID", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    const secondPage = new URL(url, "https://wallie.test").searchParams.get("cursor") === "2";
    return Response.json({
      provider: "github",
      kind: "label",
      tenant: { id: "81", label: "fixture-org" },
      resources: secondPage
        ? [{ id: "90", label: "Review requested" }]
        : [{ id: "91", label: "Alternate label" }],
      nextCursor: secondPage ? null : "2",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <GitHubRequestRule
      canManageLabels
      disabled={false}
      endpoint="/api/fixture/connectors"
      onChanged={vi.fn()}
      resource={resource}
    />,
  );

  expect(await screen.findByText("Review requested")).toBeVisible();
  expect(screen.getByText(/issue requests in fixture-org\/demo/u)).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Edit intake label" }));
  const picker = screen.getByRole("combobox", { name: "Intake label" });
  expect(picker).toHaveValue("90");
  expect(within(picker).getByRole("option", { name: "Review requested" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save intake label" })).toBeDisabled();
});
