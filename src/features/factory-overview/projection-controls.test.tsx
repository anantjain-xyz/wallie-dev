// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";

import { ProjectionControls } from "./projection-controls";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const scope = { factoryId: "example-factory", workspaceId: "example-workspace" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

it.each([
  { action: "pause", label: "Pause projection", pending: "Pausing…", paused: false },
  { action: "resume", label: "Resume projection", pending: "Resuming…", paused: true },
  { action: "rebuild", label: "Rebuild projection", pending: "Requesting rebuild…", paused: true },
])("names the pending $action, prevents more requests, and reports the result", async (item) => {
  const response = Promise.withResolvers<Response>();
  const fetch = vi.fn().mockReturnValue(response.promise);
  vi.stubGlobal("fetch", fetch);
  render(<ProjectionControls {...scope} paused={item.paused} rebuilding={false} />);
  const status = screen.getByRole("status");
  const action = screen.getByRole("button", { name: item.label });
  action.focus();
  fireEvent.click(action);
  expect(action).toHaveAccessibleName(item.pending);
  expect(action).toHaveFocus();
  expect(status).toHaveTextContent(item.pending);
  for (const button of screen.getAllByRole("button")) {
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    "/api/workspaces/example-workspace/factories/example-factory/projection-control",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ action: item.action }) }),
  );

  response.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    expect(status).toHaveTextContent(
      item.action === "rebuild" ? "Rebuild requested." : `Analytics projection ${item.action}d.`,
    );
    expect(action).toHaveAccessibleName(item.label);
    expect(action).toHaveAttribute("aria-disabled", "false");
  });
  expect(screen.getByRole("status")).toBe(status);
  expect(refresh).toHaveBeenCalledOnce();
});

it("keeps queued rebuilds unavailable and reports a rejected action without refreshing", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ error: "Action no longer available." }, { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  render(<ProjectionControls {...scope} paused rebuilding />);
  const rebuild = screen.getByRole("button", { name: "Rebuild projection" });
  expect(rebuild).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(rebuild);
  expect(fetch).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Resume projection" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Action no longer available."),
  );
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Resume projection" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  expect(rebuild).toHaveAttribute("aria-disabled", "true");
});
