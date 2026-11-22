// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { proposalReviewCommandSchema } from "@/lib/factory-proposals/workbench-contracts";

import { ImprovementReviewForm } from "./improvement-review-form";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const proposalRevisionId = "63700000-0000-4000-8000-000000000001";
const reviewerMemberId = "63700000-0000-4000-8000-000000000003";
const endpoint = "/api/test/improvement-proposals/example/review";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function review({ version = 2, member = reviewerMemberId, canReview = true } = {}) {
  return render(
    <ImprovementReviewForm
      endpoint={endpoint}
      proposalRevisionId={proposalRevisionId}
      reviewerMemberId={member}
      reviewVersion={version}
      canReview={canReview}
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

it("replays the original request after a reload updates the displayed review version", async () => {
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
          actorMemberId: reviewerMemberId,
          actorName: "Reviewer",
          createdAt: "2026-11-21T21:00:00Z",
        },
      }),
    );
  vi.stubGlobal("fetch", request);
  const firstReview = review();

  fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), {
    target: { value: "Cite the retained result." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not confirm the review was saved. Retry this review.",
  );
  firstReview.unmount();
  const anotherReviewer = review({ member: "63700000-0000-4000-8000-000000000004" });
  expect(screen.queryByRole("button", { name: "Retry review" })).toBeNull();
  anotherReviewer.unmount();

  review({ version: 3, canReview: false });
  expect(screen.queryByRole("button", { name: "Request revision" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry review" }));
  expect(await screen.findByText("Review saved.")).toHaveProperty("role", "status");
  const [first, replay] = request.mock.calls;
  expect(first[1].body).toBe(replay[1].body);
  expect(screen.queryByRole("button", { name: "Retry review" })).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
});
