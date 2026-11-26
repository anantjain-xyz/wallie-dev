// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoverySource } from "@/features/wallie/realtime-recovery";
import type { FactoryInbox, FactoryInboxKind } from "@/lib/factories/inbox-schema";
import { FactoryInboxPage, FactoryInboxUnavailable } from "./inbox-page";

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

function renderInbox(
  inbox: FactoryInbox | null,
  initialNow = happenedAt,
  scope: { cursor?: string; kind?: FactoryInboxKind; allFactories?: boolean } = {},
) {
  return render(
    <FactoryInboxPage
      cursor={scope.cursor ?? null}
      factoryId={scope.allFactories ? null : factoryId}
      initialInbox={inbox}
      initialNow={initialNow}
      kind={scope.kind}
      memberId="88888888-8888-4888-8888-888888888888"
      workspaceId={workspaceId}
      workspaceSlug="acme"
    />,
  );
}

function recoverySource() {
  const source = recovery.register.mock.calls[0]?.[0];
  if (!source) throw new Error("Inbox did not register its recovery source.");
  return source;
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

    expect(screen.getByRole("link", { name: "All items 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Reviews 1" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Clarifications 1" })).toBeVisible();
    expect(screen.getByText("Blocking feedback")).toBeVisible();
    expect(screen.getAllByText("Payments · Verify · Version 3")).toHaveLength(2);
    expect(screen.getAllByText(/Release agent/)).toHaveLength(2);
    const reviewLink = screen.getByRole("link", { name: "Open review for Payment integration" });
    expect(reviewLink).toHaveAttribute(
      "href",
      `/w/acme/sessions/22?artifactStage=verify&artifactId=${artifactId}&artifactVersion=3&reviewStageId=${stageId}&reviewRevision=7&returnTo=${encodeURIComponent(`/w/acme/inbox?factory=${factoryId}`)}`,
    );
    expect(
      screen.getByRole("link", { name: "Answer clarification for Confirm the rollout" }),
    ).toHaveAttribute(
      "href",
      `/w/acme/sessions/23?artifactStage=verify&artifactId=${artifactId}&artifactVersion=3&reviewStageId=${stageId}&reviewRevision=7&clarificationId=${clarificationId}&returnTo=${encodeURIComponent(`/w/acme/inbox?factory=${factoryId}`)}`,
    );
  });

  it("preserves the filter and cursor on the exact handoff and resets only the cursor when changing views", async () => {
    const snapshot = {
      items: [review],
      counts: { review: 27, clarification: 1 },
      nextCursor: "next",
    };
    const fetchInbox = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(snapshot));
    renderInbox(snapshot, happenedAt, { cursor: "current", kind: "review" });

    const inbox = `/w/acme/inbox?factory=${factoryId}`;
    const href = screen.getByRole("link", { name: /Open review/ }).getAttribute("href")!;
    expect(new URL(href, "http://localhost").searchParams.get("returnTo")).toBe(
      `${inbox}&kind=review&cursor=current`,
    );
    expect(screen.getByRole("link", { name: "Reviews 27" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Clarifications 1" })).toHaveAttribute(
      "href",
      `${inbox}&kind=clarification`,
    );
    expect(screen.getByRole("link", { name: "All items 28" })).toHaveAttribute("href", inbox);
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      `${inbox}&kind=review&cursor=next`,
    );
    expect(screen.getByRole("link", { name: "Back to newest" })).toHaveAttribute(
      "href",
      `${inbox}&kind=review`,
    );
    const signal = new AbortController().signal;
    await act(() => recoverySource().refresh(signal));
    expect(fetchInbox).toHaveBeenCalledWith(
      `/api/factories/inbox?workspaceId=${workspaceId}&factoryId=${factoryId}&kind=review&cursor=current`,
      { cache: "no-store", signal },
    );
  });

  it("offers separate recovery for an empty factory, older page and all-factory queue", () => {
    const view = renderInbox(empty, happenedAt, { cursor: "older", kind: "clarification" });
    expect(screen.getByText("No items on this page.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to newest" })).toBeVisible();
    expect(screen.getByRole("link", { name: "View all factories" })).toHaveAttribute(
      "href",
      "/w/acme/inbox?kind=clarification",
    );
    view.unmount();
    renderInbox(empty, happenedAt, { allFactories: true });
    expect(screen.getByText("You’re all caught up.")).toBeVisible();
    expect(screen.getByRole("link", { name: "View sessions" })).toHaveAttribute(
      "href",
      "/w/acme/sessions",
    );
  });

  it("offers an in-Inbox exit from an unavailable initial selection", () => {
    render(<FactoryInboxUnavailable factorySelector={null} kind="review" workspaceSlug="acme" />);
    expect(screen.getByRole("status")).toHaveTextContent("Factory unavailable.");
    expect(screen.getByRole("link", { name: "View all factories" })).toHaveAttribute(
      "href",
      "/w/acme/inbox?kind=review",
    );
  });

  it("acknowledges only the manual read, keeps rows visible, and prevents duplicate refreshes", async () => {
    const snapshot = { items: [review], counts: { review: 1, clarification: 0 }, nextCursor: null };
    const automatic = Promise.withResolvers<Response>();
    const manual = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(automatic.promise)
      .mockReturnValueOnce(manual.promise);
    renderInbox(snapshot);
    const source = recoverySource();
    const signal = new AbortController().signal;

    let background!: Promise<void>;
    await act(async () => {
      background = source.refresh(signal);
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const button = screen.getByRole("button", { name: "Refreshing…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing Inbox…");
    fireEvent.click(button);
    expect(recovery.retry).toHaveBeenCalledOnce();
    automatic.resolve(Response.json(snapshot));
    await act(() => background);
    expect(button).toBeDisabled();
    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();

    let requested!: Promise<void>;
    await act(async () => {
      requested = source.refresh(signal);
    });
    manual.resolve(Response.json(snapshot));
    await act(() => requested);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Inbox is up to date.");
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

    const source = recoverySource();
    const signal = new AbortController().signal;
    await act(() => source.refresh(signal));
    expect(fetchInbox).toHaveBeenCalledWith(
      `/api/factories/inbox?workspaceId=${workspaceId}&factoryId=${factoryId}`,
      { cache: "no-store", signal },
    );
    expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
    expect(screen.getByText("No pending reviews or clarifications in this factory.")).toBeVisible();
    await act(() => source.refresh(signal));
    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();
    await act(async () => {
      await expect(source.refresh(signal)).rejects.toThrow("Inbox unavailable.");
    });
    expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Inbox item type" })).toBeNull();
    expect(screen.getByText("Factory unavailable.")).toBeVisible();
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
    const source = recoverySource();

    const starting = new AbortController();
    const first = source.refresh(starting.signal).catch(() => {});
    act(() => starting.abort());
    await act(() => source.refresh(new AbortController().signal));
    await act(async () => {
      prior.reject(new Error("The old request lost its connection."));
      await first;
    });
    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();
    expect(screen.getByRole("link", { name: "Reviews 1" })).toBeVisible();
  });

  it("hides rows and counts behind a checking state when the access check is stale", () => {
    renderInbox(
      { items: [review], counts: { review: 1, clarification: 0 }, nextCursor: null },
      "2020-01-01T00:00:00.000Z",
    );

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(screen.getByText("Checking Inbox access…")).toBeVisible();
    expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Inbox item type" })).toBeNull();
    expect(recovery.invalidate).toHaveBeenCalled();
  });

  it("shows the offline state and hides protected rows when the browser goes offline", () => {
    renderInbox({ items: [review], counts: { review: 1, clarification: 0 }, nextCursor: null });

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(screen.getByText("You’re offline. Reconnect to refresh your Inbox.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Inbox item type" })).toBeNull();
  });

  it("hides server-rendered rows when mounting while offline", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderInbox({ items: [review], counts: { review: 1, clarification: 0 }, nextCursor: null });

    expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Inbox item type" })).toBeNull();
    expect(screen.getByText("You’re offline. Reconnect to refresh your Inbox.")).toBeVisible();
  });

  it("reports offline on mount and keeps it through rechecks while the browser stays offline", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderInbox(null, "2020-01-01T00:00:00.000Z");

    expect(screen.getByText("You’re offline. Reconnect to refresh your Inbox.")).toBeVisible();
    expect(screen.queryByText("Checking Inbox access…")).toBeNull();
    expect(screen.queryByText("Factory unavailable.")).toBeNull();
    expect(recovery.invalidate).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(screen.getByText("You’re offline. Reconnect to refresh your Inbox.")).toBeVisible();
    expect(screen.queryByText("Checking Inbox access…")).toBeNull();
    expect(recovery.invalidate).toHaveBeenCalledTimes(1);
  });

  it("restores rows when a refresh succeeds after coming back online", async () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        items: [review],
        counts: { review: 1, clarification: 0 },
        nextCursor: null,
      }),
    );
    renderInbox(null);
    const source = recoverySource();
    expect(screen.getByText("You’re offline. Reconnect to refresh your Inbox.")).toBeVisible();

    onLine.mockReturnValue(true);
    await act(() => source.refresh(new AbortController().signal));

    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();
    expect(screen.queryByText("You’re offline. Reconnect to refresh your Inbox.")).toBeNull();
  });

  it.each([401, 403, 404])(
    "treats a %i response as unavailable without confirming the resource exists",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({}, { status }));
      renderInbox(null);
      const source = recoverySource();

      await act(async () => {
        await expect(source.refresh(new AbortController().signal)).rejects.toThrow(
          "Inbox unavailable.",
        );
      });
      expect(screen.getByText("Factory unavailable.")).toBeVisible();
      expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
    },
  );

  it("reports a failed read distinctly from denied access and restores rows on success", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({}, { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({
          items: [review],
          counts: { review: 1, clarification: 0 },
          nextCursor: null,
        }),
      );
    renderInbox(null);
    const source = recoverySource();

    await act(async () => {
      await expect(source.refresh(new AbortController().signal)).rejects.toThrow(
        "Inbox unavailable.",
      );
    });
    expect(screen.getByText("Couldn’t load Inbox. Refresh to try again.")).toBeVisible();
    expect(screen.queryByText("Factory unavailable.")).toBeNull();

    await act(() => source.refresh(new AbortController().signal));
    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();
    expect(screen.getByRole("link", { name: "Reviews 1" })).toBeVisible();
  });

  it("keeps fresh rows visible while a refresh revalidates, then updates them", async () => {
    const pending = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => pending.promise);
    renderInbox({ items: [review], counts: { review: 1, clarification: 0 }, nextCursor: null });
    const source = recoverySource();

    let refresh!: Promise<void>;
    await act(async () => {
      refresh = source.refresh(new AbortController().signal);
    });
    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();
    expect(screen.getByRole("link", { name: "Reviews 1" })).toBeVisible();
    expect(screen.queryByText("Checking Inbox access…")).toBeNull();

    pending.resolve(Response.json(empty));
    await act(() => refresh);
    expect(screen.getByText("No pending reviews or clarifications in this factory.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: review.title })).toBeNull();
  });

  it("moves a hidden view to checking while the first read is in flight", async () => {
    const pending = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => pending.promise);
    renderInbox(null);
    const source = recoverySource();

    expect(screen.getByText("Factory unavailable.")).toBeVisible();

    let refresh!: Promise<void>;
    await act(async () => {
      refresh = source.refresh(new AbortController().signal);
    });
    expect(screen.getByText("Checking Inbox access…")).toBeVisible();

    pending.resolve(
      Response.json({
        items: [review],
        counts: { review: 1, clarification: 0 },
        nextCursor: null,
      }),
    );
    await act(() => refresh);
    expect(screen.getByRole("heading", { name: review.title })).toBeVisible();
  });
});
