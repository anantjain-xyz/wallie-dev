// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import { FailureGroupReview } from "./failure-group-review";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("submits runs selected on different pages and clears selections when membership changes", async () => {
  const endpoint = "/api/workspaces/test/factories/test/failure-groups/test/review";
  const digest = "a".repeat(64);
  const first = { id: "63400000-0000-4000-8000-000000000001", label: "Run one" };
  const second = { id: "63400000-0000-4000-8000-000000000002", label: "Run two" };
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      review: { revision: 2, disposition: "split", label: null, can_review: false },
      split_cohort_ids: [],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  function review(run: typeof first, membershipDigest = digest) {
    return (
      <FailureGroupReview
        endpoint={endpoint}
        revision={1}
        label={null}
        split={{ digest: membershipDigest, runs: [run], firstPage: null, nextPage: null }}
      />
    );
  }

  const { rerender } = render(review(first));
  fireEvent.click(screen.getByText("Split by run"));
  fireEvent.click(screen.getByRole("checkbox", { name: first.label }));
  rerender(review(second));
  expect(screen.getByText("1 run selected")).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "Selected runs across pages" })).getByText(first.label),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: second.label }));
  expect(screen.getByText("2 runs selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Split group" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Review saved."));
  expect(fetchMock).toHaveBeenCalledWith(
    endpoint,
    expect.objectContaining({
      body: expect.stringContaining(`"selectedRunIds":["${first.id}","${second.id}"]`),
    }),
  );

  rerender(review(first, "b".repeat(64)));
  fireEvent.click(screen.getByText("Split by run"));
  expect(screen.getByText("0 runs selected")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: first.label })).toHaveProperty("checked", false);
});

it("requires explicit confirmation and keeps dismissal pending until a response", async () => {
  let finish!: (result: Response) => void;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <PortalRootProvider>
      <FailureGroupReview endpoint="/review" revision={1} label={null} split={null} />
    </PortalRootProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Dismiss group" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("Run evidence stays available.");
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Dismiss group" }),
  );
  expect(screen.getByRole("button", { name: "Dismissing…" })).toHaveProperty("disabled", true);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(
    "/review",
    expect.objectContaining({
      body: expect.stringContaining('"action":"dismiss"'),
    }),
  );
  finish(
    Response.json({
      review: { revision: 2, disposition: "dismissed", label: null, can_review: false },
      split_cohort_ids: [],
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});
