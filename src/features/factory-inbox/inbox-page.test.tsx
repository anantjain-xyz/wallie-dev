// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoverySource } from "@/features/wallie/realtime-recovery";
import type { FactoryInbox } from "@/lib/factories/inbox-schema";
import { FactoryInboxPage } from "./inbox-page";

const recovery = vi.hoisted(() => ({
  register: vi.fn<(source: RecoverySource) => () => void>(() => () => {}),
  invalidate: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("@/features/wallie/realtime-recovery-context", () => ({
  useRealtimeRecovery: () => ({ recovery }),
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const factoryId = "22222222-2222-4222-8222-222222222222";
const stageId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const clarificationId = "55555555-5555-4555-8555-555555555555";
const happenedAt = "2026-11-19T08:00:00.000Z";
const empty = { items: [], counts: { review: 0, clarification: 0 }, nextCursor: null };
const review = {
  sessionId: "66666666-6666-4666-8666-666666666666",
  sessionNumber: 22,
  title: "Payment integration",
  factoryId,
  factoryName: "Payments",
  stageId,
  stageSlug: "verify",
  stageName: "Verify",
  artifactId,
  artifactVersion: 3,
  reviewRevision: 7,
  clarificationId: null,
  kind: "review",
  sourceLabel: "Release agent",
  occurredAt: happenedAt,
  hasBlockingFeedback: true,
} as const;

function renderInbox(inbox: FactoryInbox) {
  return render(
    <FactoryInboxPage
      cursor={null}
      factoryId={factoryId}
      initialInbox={inbox}
      initialNow={happenedAt}
      memberId="88888888-8888-4888-8888-888888888888"
      workspaceId={workspaceId}
      workspaceSlug="acme"
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("FactoryInboxPage", () => {
  it("links to the exact review and clarification with factory and source context", () => {
    renderInbox({
      items: [
        review,
        {
          ...review,
          title: "Confirm the rollout",
          sessionId: "77777777-7777-4777-8777-777777777777",
          sessionNumber: 23,
          kind: "clarification",
          clarificationId,
          hasBlockingFeedback: false,
        },
      ],
      counts: { review: 1, clarification: 1 },
      nextCursor: null,
    });

    expect(screen.getByText("1 awaiting review · 1 clarification")).toBeVisible();
    expect(screen.getByText("Blocking feedback")).toBeVisible();
    expect(screen.getAllByText("Payments · Verify · Version 3")).toHaveLength(2);
    expect(screen.getAllByText(/Release agent/)).toHaveLength(2);
    const reviewLink = screen.getByRole("link", { name: "Open review for Payment integration" });
    expect(reviewLink).toHaveAttribute(
      "href",
      `/w/acme/sessions/22?artifactStage=verify&artifactId=${artifactId}&artifactVersion=3&reviewStageId=${stageId}&reviewRevision=7`,
    );
    expect(
      screen.getByRole("link", { name: "Answer clarification for Confirm the rollout" }),
    ).toHaveAttribute(
      "href",
      `/w/acme/sessions/23?artifactStage=verify&artifactId=${artifactId}&artifactVersion=3&reviewStageId=${stageId}&reviewRevision=7&clarificationId=${clarificationId}`,
    );
  });

  it("replaces rows and counts with fresh scoped reads and clears them if access is denied", async () => {
    const fetchInbox = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(empty))
      .mockResolvedValueOnce(
        Response.json({
          items: [review],
          counts: { review: 1, clarification: 0 },
          nextCursor: null,
        }),
      )
      .mockResolvedValueOnce(Response.json({}, { status: 404 }));
    renderInbox({ items: [review], counts: { review: 1, clarification: 0 }, nextCursor: null });

    const source = recovery.register.mock.calls[0]?.[0];
    if (!source) throw new Error("Inbox did not register its recovery source.");
    const signal = new AbortController().signal;
    await act(() => source.refresh(signal));
    expect(fetchInbox).toHaveBeenCalledWith(
      `/api/factories/inbox?workspaceId=${workspaceId}&factoryId=${factoryId}`,
      { cache: "no-store", signal },
    );
    expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
    expect(screen.getByText("You’re all caught up.")).toBeVisible();
    await act(() => source.refresh(signal));
    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();
    await act(async () => {
      await expect(source.refresh(signal)).rejects.toThrow("Inbox unavailable.");
    });
    expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
    expect(screen.queryByText("1 awaiting review · 0 clarifications")).toBeNull();
    expect(screen.getByText("Inbox unavailable. Refresh to check your access.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(recovery.retry).toHaveBeenCalledOnce();
  });

  it("keeps the reconnect snapshot when a superseded refresh fails late", async () => {
    const prior = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => prior.promise)
      .mockResolvedValueOnce(
        Response.json({
          items: [review],
          counts: { review: 1, clarification: 0 },
          nextCursor: null,
        }),
      );
    renderInbox(empty);
    const source = recovery.register.mock.calls[0]?.[0];
    if (!source) throw new Error("Inbox did not register its recovery source.");

    const starting = new AbortController();
    const first = source.refresh(starting.signal).catch(() => {});
    act(() => starting.abort());
    await act(() => source.refresh(new AbortController().signal));
    await act(async () => {
      prior.reject(new Error("The old request lost its connection."));
      await first;
    });
    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();
    expect(screen.getByText("1 awaiting review · 0 clarifications")).toBeVisible();
  });
});
