// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";

import { ConnectorResources } from "./resources";

const workspaceId = "67600000-0000-4000-8000-000000000001";
const factoryId = "67600000-0000-4000-8000-000000000002";
const endpoint = `/api/workspaces/${workspaceId}/factories/${factoryId}/connectors`;
const emptyInventory = { canConfigure: false, installations: [], resources: [] };
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
