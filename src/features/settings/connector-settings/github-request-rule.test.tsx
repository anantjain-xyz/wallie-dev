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
const intakeLabel = { name: "Intake label", exact: true };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function labelPage(resources: { id: string; label: string }[], nextCursor: string | null = null) {
  return Response.json({
    provider: "github",
    kind: "label",
    tenant: { id: "81", label: "fixture-org" },
    resources,
    nextCursor,
  });
}

function renderRule(githubRequests = resource.githubRequests) {
  const user = userEvent.setup();
  const onChanged = vi.fn();
  const props = {
    canManageLabels: true,
    disabled: false,
    endpoint: "/api/fixture/connectors",
    onChanged,
  };
  const { rerender } = render(
    <GitHubRequestRule {...props} resource={{ ...resource, githubRequests }} />,
  );
  return {
    onChanged,
    user,
    updateRules: (rules: ConnectorResource["githubRequests"]) =>
      rerender(<GitHubRequestRule {...props} resource={{ ...resource, githubRequests: rules }} />),
  };
}

it("finds the saved repository label beyond the first page and preselects its exact ID", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    const secondPage = new URL(url, "https://wallie.test").searchParams.get("cursor") === "2";
    return secondPage
      ? labelPage([{ id: "90", label: "Review requested" }])
      : labelPage([{ id: "91", label: "Alternate label" }], "2");
  });
  vi.stubGlobal("fetch", fetchMock);
  const { updateRules, user } = renderRule();

  expect(await screen.findByText("Review requested")).toBeVisible();
  expect(screen.getByText(/issue requests in fixture-org\/demo/u)).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Edit intake label" }));
  const picker = screen.getByRole("combobox", intakeLabel);
  expect(picker).toHaveAttribute("data-value", "90");
  expect(picker).toHaveTextContent("Review requested");
  await user.click(picker);
  const saved = within(screen.getByRole("listbox", intakeLabel)).getByRole("option", {
    name: "Review requested",
  });
  expect(saved).toHaveAttribute("data-value", "90");
  expect(saved).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "Save intake label" })).toBeDisabled();
  await user.click(saved);
  updateRules([{ enabled: true, revision: 3, sourceKind: "issue", labelId: 91 }]);
  const refreshedPicker = await screen.findByRole("combobox", intakeLabel);
  expect(refreshedPicker).toHaveAttribute("data-value", "91");
  expect(refreshedPicker).toHaveTextContent("Alternate label");
  expect(screen.getByRole("button", { name: "Save intake label" })).toBeDisabled();
});

it("keeps an unresolved saved label selected but skips it when choosing a replacement", async () => {
  const fetchMock = vi.fn(async () => labelPage([{ id: "91", label: "Alternate label" }]));
  vi.stubGlobal("fetch", fetchMock);
  const { user } = renderRule();

  await user.click(screen.getByRole("button", { name: "Edit intake label" }));
  const picker = await screen.findByRole("combobox", intakeLabel);
  const save = screen.getByRole("button", { name: "Save intake label" });
  expect(picker).toHaveAttribute("data-value", "90");
  expect(picker).toHaveTextContent("Label unavailable — choose a replacement.");
  expect(save).toBeDisabled();

  await user.click(picker);
  const options = within(screen.getByRole("listbox", intakeLabel));
  const unresolved = options.getByRole("option", {
    name: "Label unavailable — choose a replacement.",
  });
  expect(unresolved).toHaveAttribute("aria-disabled", "true");
  expect(unresolved).toHaveAttribute("aria-selected", "true");
  expect(options.getByRole("option", { name: "Choose a label" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(options.getByRole("option", { name: "Alternate label" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(picker).toHaveFocus();
  expect(picker).toHaveAttribute("data-value", "91");
  expect(save).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retains a draft through failed pagination and retries, and saves only a chosen label", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(labelPage([{ id: "91", label: "First label" }], "2"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(labelPage([{ id: "92", label: "Later label" }]))
    .mockResolvedValueOnce(Response.json({ revision: 1 }));
  vi.stubGlobal("fetch", fetchMock);
  const { onChanged, user } = renderRule([]);
  const retry = { name: "Retry repository labels lookup" };

  await user.click(screen.getByRole("button", { name: "Find repository labels" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load repository labels");
  expect(screen.queryByRole("combobox", intakeLabel)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", retry));

  const picker = await screen.findByRole("combobox", intakeLabel);
  const save = screen.getByRole("button", { name: "Save intake label" });
  expect(picker).toHaveTextContent("Choose a label");
  expect(picker).toHaveAttribute("data-value", "");
  expect(save).toBeDisabled();
  await user.click(picker);
  await user.click(
    within(screen.getByRole("listbox", intakeLabel)).getByRole("option", { name: "First label" }),
  );
  await user.click(screen.getByRole("button", { name: "Load more repository labels" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load repository labels");
  expect(picker).toHaveAttribute("data-value", "91");
  await user.click(screen.getByRole("button", retry));
  await user.click(picker);
  const options = within(screen.getByRole("listbox", intakeLabel));
  expect(options.getByRole("option", { name: "First label" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(options.getByRole("option", { name: "Choose a label" }));
  expect(picker).toHaveAttribute("data-value", "");
  expect(save).toBeDisabled();

  await user.click(picker);
  await user.click(
    within(screen.getByRole("listbox", intakeLabel)).getByRole("option", { name: "Later label" }),
  );
  expect(picker).toHaveAttribute("data-value", "92");
  expect(save).toBeEnabled();
  expect(
    fetchMock.mock.calls.map(([url]) =>
      new URL(String(url), "https://wallie.test").searchParams.get("cursor"),
    ),
  ).toEqual([null, null, "2", "2"]);
  expect(onChanged).not.toHaveBeenCalled();
  await user.click(save);
  expect(await screen.findByText("GitHub intake label saved.")).toBeVisible();
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/fixture/connectors/setup",
    expect.objectContaining({
      body: JSON.stringify({
        action: "github_request",
        resourceId: resource.id,
        sourceKind: "issue",
        expectedRevision: 0,
        labelId: 92,
        labelName: "Later label",
      }),
      method: "POST",
    }),
  );
  expect(onChanged).toHaveBeenCalledOnce();
});
