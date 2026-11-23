// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { automationAdmissionControlSchema } from "@/lib/factory-automations/admission-control-contracts";

import { AutomationAdmissionPanel } from "./automation-admission-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const enabled = automationAdmissionControlSchema.parse({
  automationId: "66410000-0000-4000-8000-000000000406",
  generation: 1,
  maxConcurrentSessions: 1,
  paused: false,
});
const paused = { ...enabled, generation: 2, paused: true };

function panel(initial: typeof enabled | null) {
  return (
    <AutomationAdmissionPanel activeRevision initial={initial} endpoint="/admission-control" />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("displays recovered control and later changes from the server for the same rule", () => {
  const { rerender } = render(panel(null));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not load automation status");

  rerender(panel(enabled));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Pause automation" })).toBeEnabled();

  rerender(panel(paused));
  expect(screen.getByRole("status")).toHaveTextContent("Paused");
  expect(screen.getByRole("button", { name: "Resume automation" })).toBeEnabled();
});

it("retains the confirmed control and conflict feedback while the server refreshes", async () => {
  const latest = { ...enabled, generation: 3, maxConcurrentSessions: 2 };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({}, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ control: paused }))
    .mockResolvedValueOnce(Response.json({ control: { ...latest, generation: 4, paused: true } }));
  vi.stubGlobal("fetch", fetch);
  const { rerender } = render(panel(enabled));

  await userEvent.click(screen.getByRole("button", { name: "Pause automation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The automation changed");
  expect(screen.getByRole("button", { name: "Resume automation" })).toBeEnabled();

  rerender(panel({ ...enabled }));
  expect(screen.getByRole("status")).toHaveTextContent("Paused");
  rerender(panel(paused));
  expect(screen.getByRole("alert")).toHaveTextContent("The automation changed");

  rerender(panel(latest));
  expect(screen.getByRole("status")).toHaveTextContent("Enabled");
  rerender(panel(null));
  expect(screen.getByRole("status")).toHaveTextContent("Enabled");
  rerender(panel(enabled));
  expect(screen.getByRole("status")).toHaveTextContent("Enabled");

  await userEvent.click(screen.getByRole("button", { name: "Pause automation" }));
  await screen.findByRole("button", { name: "Resume automation" });
  expect(fetch).toHaveBeenLastCalledWith(
    "/admission-control",
    expect.objectContaining({
      body: JSON.stringify({ expectedGeneration: 3, paused: true, maxConcurrentSessions: 2 }),
    }),
  );
});

it("keeps newer server status when an older command response comes back later", async () => {
  const pending = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(pending.promise));
  const { rerender } = render(panel(enabled));

  await userEvent.click(screen.getByRole("button", { name: "Pause automation" }));
  rerender(panel({ ...enabled, generation: 3 }));
  await act(async () => pending.resolve(Response.json({ control: paused })));
  rerender(panel(null));

  expect(screen.getByRole("status")).toHaveTextContent("Enabled");
  expect(screen.getByRole("button", { name: "Pause automation" })).toBeEnabled();
});
