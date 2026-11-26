// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { FailureRevisionPicker } from "./failure-revision-picker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("pages named revisions within the selected factory and retains a deep-linked revision", async () => {
  const current = {
    id: "63400000-0000-4000-8000-000000000001",
    label: "Factory revision · Activation 30",
    detail: "Active",
  };
  const pinned = {
    id: "63400000-0000-4000-8000-000000000002",
    label: "Factory revision · Activation 3",
    detail: "Historical",
  };
  const older = {
    id: "63400000-0000-4000-8000-000000000003",
    label: "Factory revision · Activation 5",
    detail: "Historical",
  };
  const fetchPage = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ options: [older], next: null }));
  vi.stubGlobal("fetch", fetchPage);
  render(
    <FailureRevisionPicker
      endpoint="/failure-groups/revisions?factory=factory-a"
      initialPage={{ options: [current], next: current.id }}
      pinned={[pinned]}
      selected={pinned.id}
    />,
  );
  const picker = screen.getByRole("combobox", { name: "Factory definition revision" });
  expect(picker.textContent).toContain(pinned.label);
  fireEvent.click(screen.getByRole("button", { name: "Older revisions" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Older revisions" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Showing older revisions"),
  );
  expect(picker.textContent).toContain(pinned.label);
  expect(fetchPage).toHaveBeenLastCalledWith(
    new URL(
      `/failure-groups/revisions?factory=factory-a&before=${current.id}`,
      window.location.origin,
    ),
    { cache: "no-store" },
  );
  fireEvent.click(screen.getByRole("button", { name: "Latest revisions" }));
  expect(picker.textContent).toContain(pinned.label);
  expect(screen.getByRole("button", { name: "Older revisions" })).toBeTruthy();
});
