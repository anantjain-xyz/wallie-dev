// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function reviewForm({
  version = 2,
  member = reviewerMemberId,
  canReview = true,
  revision = proposalRevisionId,
  revisionNumber = 1,
} = {}) {
  return (
    <ImprovementReviewForm
      endpoint={endpoint}
      proposalRevisionId={revision}
      revisionNumber={revisionNumber}
      reviewerMemberId={member}
      reviewVersion={version}
      canReview={canReview}
    />
  );
}

function review(options?: Parameters<typeof reviewForm>[0]) {
  return render(reviewForm(options));
}

it("submits feedback for the displayed revision and stops writes when that revision becomes stale", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: "The proposal changed. Reload before reviewing." }, { status: 409 }),
    );
  vi.stubGlobal("fetch", request);
  const page = review();

  fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), {
    target: { value: "Check the affected stage." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Mark for investigation" }));
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
  expect(screen.queryByRole("button", { name: "Dismiss proposal" })).toBeNull();
  expect(screen.getByRole("alert")).toBe(document.activeElement);
  fireEvent.click(screen.getByRole("button", { name: "Reload review" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  page.rerender(reviewForm({ canReview: false }));
  const draft = screen.getByRole("textbox", { name: "Unsubmitted note · Revision 1" });
  expect(draft).toHaveProperty("readOnly", true);
  expect(draft).toHaveProperty("value", "Check the affected stage.");
  page.rerender(
    reviewForm({
      revision: "63700000-0000-4000-8000-000000000009",
      revisionNumber: 2,
      version: 0,
    }),
  );
  expect(screen.getByRole("textbox", { name: "Review note" })).toHaveProperty("value", "");
  expect(screen.getByRole("textbox", { name: "Unsubmitted note · Revision 1" })).toHaveProperty(
    "value",
    "Check the affected stage.",
  );
  expect(request).toHaveBeenCalledOnce();
});

it("confirms dismissal of the displayed revision and keeps the note on Escape", async () => {
  const request = vi.fn().mockResolvedValue(
    Response.json({
      replay: false,
      event: {
        id: "63700000-0000-4000-8000-000000000002",
        version: 3,
        action: "dismiss",
        note: "Keep the receipts.",
        actorMemberId: reviewerMemberId,
        actorName: "Reviewer",
        createdAt: "2026-11-21T21:00:00Z",
      },
    }),
  );
  vi.stubGlobal("fetch", request);
  const user = userEvent.setup();
  review();
  const note = screen.getByRole("textbox", { name: "Review note" });
  await user.type(note, "Keep the receipts.");
  const trigger = screen.getByRole("button", { name: "Dismiss proposal" });
  await user.click(trigger);
  const confirmation = screen.getByRole("alertdialog", { name: "Dismiss this revision?" });
  expect(confirmation.textContent).toContain("prevents publication of revision 1");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  expect(request).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(note).toHaveProperty("value", "Keep the receipts.");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "Dismiss revision" }));
  expect(await screen.findByText("Review saved.")).toHaveProperty("role", "status");
  const [, init] = request.mock.calls[0];
  expect(proposalReviewCommandSchema.parse(JSON.parse(init.body))).toMatchObject({
    proposalRevisionId,
    action: "dismiss",
    note: "Keep the receipts.",
  });
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
  expect(screen.getByText("Request revision · Revision 1")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry review" }));
  expect(
    await screen.findByText("Revision request recorded. No revision was started."),
  ).toHaveProperty("role", "status");
  const [first, replay] = request.mock.calls;
  expect(first[1].body).toBe(replay[1].body);
  expect(screen.queryByRole("button", { name: "Retry review" })).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
});
