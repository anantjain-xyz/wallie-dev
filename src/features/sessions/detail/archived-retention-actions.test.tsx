// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";

import { ArchivedRetentionActions } from "./archived-retention-actions";

const sessionId = "58800000-0000-4000-8000-000000000001";
const archivedAt = "2026-11-19T17:00:00+00:00";
const erasedAt = "2026-11-19T17:01:00+00:00";
const url = `/api/sessions/${sessionId}/retained-content`;

function setup(canErase: boolean, fail = false) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "DELETE") return Response.json({ archivedAt, erasedAt: null, canErase });
    if (fail) return Response.json({ error: "The archive changed." }, { status: 409 });
    return Response.json({ archivedAt, erasedAt, canErase: false });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <ArchivedRetentionActions
      initialStatus={{ archivedAt, erasedAt: null, canErase }}
      sessionId={sessionId}
    >
      <button type="button">Unarchive</button>
    </ArchivedRetentionActions>,
    { wrapper: PortalRootProvider },
  );
  return { fetch, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("archived retained content", () => {
  it("confirms one exact archive and shows the durable erasure state", async () => {
    const { fetch, user } = setup(true);
    const trigger = await screen.findByRole("button", { name: "Erase retained content" });
    await user.click(trigger);
    const dialog = await screen.findByRole("alertdialog", {
      name: "Erase retained session content?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Erase content" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Retained content erased");
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          expectedArchivedAt: archivedAt,
          confirmation: "Erase retained content",
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Unarchive" })).not.toBeInTheDocument();
  });

  it("shows a stale-archive conflict inside the confirmation", async () => {
    const { user } = setup(true, true);
    await user.click(await screen.findByRole("button", { name: "Erase retained content" }));
    await user.click(await screen.findByRole("button", { name: "Erase content" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The archive changed.");
    expect(screen.queryByText("Retained content erased")).not.toBeInTheDocument();
  });
});
