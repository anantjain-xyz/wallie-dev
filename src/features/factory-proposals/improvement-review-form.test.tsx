// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { proposalReviewCommandSchema } from "@/lib/factory-proposals/workbench-contracts";

import { ImprovementReviewForm } from "./improvement-review-form";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const proposalRevisionId = "63700000-0000-4000-8000-000000000001";
const endpoint = "/api/test/improvement-proposals/example/review";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function review() {
  return render(
    <ImprovementReviewForm
      endpoint={endpoint}
      proposalRevisionId={proposalRevisionId}
      reviewVersion={2}
    />,
  );
}

it("submits feedback for the displayed revision and stops writes when that revision becomes stale", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: "The proposal changed. Reload before reviewing." }, { status: 409 }),
    );
  vi.stubGlobal("fetch", request);
  review();

  fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), {
    target: { value: "Check the affected stage." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Investigate" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "The proposal changed. Reload before reviewing.",
  );
  const [, init] = request.mock.calls[0];
  expect(proposalReviewCommandSchema.parse(JSON.parse(init.body))).toMatchObject({
    proposalRevisionId,
    expectedReviewVersion: 2,
    action: "investigate",
    note: "Check the affected stage.",
  });
  expect(screen.getByRole("button", { name: "Dismiss proposal" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Reload review" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});

it("reuses the exact request identity when a review response is lost", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValueOnce(
      Response.json({
        replay: true,
        event: {
          id: "63700000-0000-4000-8000-000000000002",
          version: 3,
          action: "revise",
          note: "Cite the retained result.",
          actorMemberId: "63700000-0000-4000-8000-000000000003",
          actorName: "Reviewer",
          createdAt: "2026-11-21T21:00:00Z",
        },
      }),
    );
  vi.stubGlobal("fetch", request);
  review();

  fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), {
    target: { value: "Cite the retained result." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not confirm the review was saved. Retry the same action.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Review saved.");
  const [first, replay] = request.mock.calls;
  expect(first[1].body).toBe(replay[1].body);
  expect(refresh).toHaveBeenCalledOnce();
});
