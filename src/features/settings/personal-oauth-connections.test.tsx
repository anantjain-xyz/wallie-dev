// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { PersonalOAuthConnections } from "@/features/settings/personal-oauth-connections";
import type { PersonalOAuthGrant } from "@/features/settings/personal-oauth-data";
import { factoryCommandLabels } from "@/lib/factory-machine-tokens/contracts";

const mocks = vi.hoisted(() => ({ loadConnections: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/features/settings/personal-oauth-data", () => ({
  loadPersonalOAuthConnections: mocks.loadConnections,
}));
vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: () => ({
    currentMember: { id: "self", is_active: true, kind: "human" },
    workspace: { id: "workspace-1", slug: "seeded" },
  }),
}));

const readScope = Object.keys(factoryCommandLabels)[0] as keyof typeof factoryCommandLabels;
const recent: PersonalOAuthGrant = {
  id: "grant-recent",
  clientName: "Publishing client",
  connectedAt: "2026-05-03T10:00:00.000Z",
  expiresAt: "2026-12-01T10:00:00.000Z",
  status: "Active",
  scopes: [readScope],
  factories: [{ id: "factory-1", name: "Docs Factory", scopes: [readScope] }],
};
const older: PersonalOAuthGrant = {
  ...recent,
  id: "grant-older",
  connectedAt: "2026-05-01T10:00:00.000Z",
  factories: [{ id: "factory-2", name: "App Factory", scopes: [readScope] }],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.loadConnections.mockReset();
  mocks.refresh.mockReset();
});

describe("personal connected clients", () => {
  it("repeats the chosen connection's factory, scope and time before revoking the exact grant", async () => {
    const user = userEvent.setup();
    mocks.loadConnections.mockResolvedValue({ grants: [recent, older] });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ revoked: true }));
    render(
      <OverlayProvider>
        {await PersonalOAuthConnections({ workspaceSlug: "seeded" })}
      </OverlayProvider>,
    );

    expect(screen.getByRole("link", { name: "Active connections" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const [recentTrigger, olderTrigger] = screen.getAllByRole("button", {
      name: /Disconnect client: Publishing client/,
    });
    expect(recentTrigger).toHaveAccessibleName(expect.stringContaining("Docs Factory"));
    expect(olderTrigger).toHaveAccessibleName(expect.stringContaining("App Factory"));
    await user.click(olderTrigger);
    const dialog = await screen.findByRole("alertdialog", {
      name: "Disconnect Publishing client?",
    });
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining("App Factory"));
    expect(within(dialog).getByText("App Factory")).toBeVisible();
    expect(dialog).toHaveTextContent(factoryCommandLabels[readScope]);
    expect(within(dialog).getByText(/May 1, 2026.*UTC/)).toHaveAttribute(
      "datetime",
      older.connectedAt,
    );
    expect(within(dialog).queryByText("Docs Factory")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect client" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/oauth-clients",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "revoke-grant", grantId: older.id }),
      }),
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("shows history without disconnect actions and keeps a nameless record recognizable", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    mocks.loadConnections.mockResolvedValue({
      grants: [
        { ...older, clientName: "Client name unavailable", factories: [], status: "Expired" },
      ],
    });
    render(await PersonalOAuthConnections({ history: true, workspaceSlug: "seeded" }));

    expect(screen.getByRole("link", { name: "Connection history" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: "Client name unavailable" })).toBeVisible();
    expect(screen.getByText("Expired", { exact: true })).toBeVisible();
    expect(screen.getByText(/Factory details unavailable · Approved scopes:/)).toHaveTextContent(
      factoryCommandLabels[readScope],
    );
    expect(screen.queryByRole("button", { name: /Disconnect client/ })).not.toBeInTheDocument();
    await user.click(screen.getByText("Support details"));
    await user.click(screen.getByRole("button", { name: "Copy connection ID" }));
    expect(copy).toHaveBeenCalledWith(older.id);
    expect(screen.getByRole("status")).toHaveTextContent("Connection ID copied.");
  });
});
