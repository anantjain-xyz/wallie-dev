// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createArtifactSourceAnchor } from "./source-anchor";
import { publishArtifactFeedbackSubmission } from "./submission-events";
import type { ArtifactReviewComment, ArtifactReviewThread, ReviewThreadListPayload } from "./types";

const realtime = vi.hoisted(() => ({
  enabled: false,
  event: undefined as (() => void) | undefined,
  status: undefined as ((status: string) => void) | undefined,
  remove: vi.fn(),
  filter: "",
}));
vi.mock("@/lib/supabase/public-config-provider", () => ({
  useSupabasePublicConfig: () => (realtime.enabled ? publicConfig : null),
}));
const publicConfig = { url: "https://example.supabase.co", publishableKey: "test-key" };
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => {
    const channel = {
      on: (_event: string, options: { filter: string }, callback: () => void) => {
        realtime.filter = options.filter;
        realtime.event = callback;
        return channel;
      },
      subscribe: (callback: (status: string) => void) => {
        realtime.status = callback;
        return channel;
      },
    };
    return { channel: () => channel, removeChannel: realtime.remove };
  },
}));

import { ArtifactReviewPanel, type ArtifactReviewPanelProps } from "./review-panel";

const anchor = createArtifactSourceAnchor(
  "Review this paragraph with a clear retry policy.",
  0,
  21,
);
function makeThread(
  id = "thread-1",
  overrides: Partial<ArtifactReviewThread> = {},
): ArtifactReviewThread {
  return {
    id,
    workspace_id: "workspace-1",
    session_id: "session-1",
    artifact_id: "artifact-1",
    stage_id: "stage-1",
    stage_slug: "plan",
    artifact_version: 1,
    anchor,
    kind: "discussion",
    status: "open",
    author_member_id: "member-1",
    author_label: "Alex",
    revision: 1,
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
    ...overrides,
  };
}
function makeComment(
  id = "comment-1",
  overrides: Partial<ArtifactReviewComment> = {},
): ArtifactReviewComment {
  return {
    id,
    workspace_id: "workspace-1",
    thread_id: "thread-1",
    author_member_id: "member-1",
    author_label: "Alex",
    body: "Please explain the retry policy.",
    revision: 1,
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
    ...overrides,
  };
}
let snapshot: ReviewThreadListPayload;
let comments: ArtifactReviewComment[];
let saves: Array<{ method: string; path: string; body: Record<string, unknown> }>;
let saveFailures: number;
let failureStatus: number;
let networkFailures: number;
let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
const clearAnchor = vi.fn();
function panel(overrides: Partial<ArtifactReviewPanelProps> = {}) {
  return (
    <ArtifactReviewPanel
      sessionId="session-1"
      artifactId="artifact-1"
      artifactVersion={1}
      historical={false}
      anchor={null}
      onClearAnchor={clearAnchor}
      {...overrides}
    />
  );
}
beforeEach(() => {
  window.history.replaceState({}, "", "/w/acme/sessions/session-1");
  realtime.enabled = false;
  realtime.event = undefined;
  realtime.status = undefined;
  realtime.remove.mockReset();
  clearAnchor.mockReset();
  snapshot = {
    reviewRevision: 7,
    submittedThreadRevisions: {},
    threads: [makeThread()],
    nextCursor: null,
    counts: { total: 1, open: 1, blocking: 0 },
    viewer: { memberId: "member-1", canReview: false, readOnlyReason: null },
  };
  comments = [makeComment()];
  saves = [];
  saveFailures = 0;
  failureStatus = 503;
  networkFailures = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "https://wallie.test");
    if (init?.method === "POST" || init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      saves.push({ method: init.method, path: url.pathname, body });
      if (networkFailures-- > 0) throw new TypeError("Network connection lost.");
      if (saveFailures-- > 0) {
        if (failureStatus === 409) {
          comments = comments.map((comment) => ({ ...comment, revision: comment.revision + 1 }));
          snapshot.threads = snapshot.threads.map((thread) => ({
            ...thread,
            revision: thread.revision + 1,
          }));
        }
        return Response.json({ error: "Connection interrupted." }, { status: failureStatus });
      }
      if (url.pathname.endsWith("/comments"))
        return Response.json({
          comment: makeComment("saved-comment", { body: String(body.body) }),
        });
      if (init.method === "PATCH")
        return Response.json({
          thread: makeThread("thread-1", { status: String(body.status), revision: 2 }),
        });
      return Response.json({ thread: makeThread("saved-thread") });
    }
    if (url.pathname.endsWith("/comments")) return Response.json({ comments, nextCursor: null });
    if (/\/reviews\/[^/]+$/.test(url.pathname))
      return Response.json({
        thread: makeThread(url.pathname.split("/").at(-1)),
        submittedThreadRevision: null,
      });
    return Response.json(snapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function selectThread(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Discussion · open/ }));
  await screen.findByLabelText("Reply to thread");
}

describe("artifact threaded review", () => {
  it("refreshes mounted submission labels after an exact accepted receipt without losing drafts or selection", async () => {
    const user = userEvent.setup();
    const scope = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      artifactId: "22222222-2222-4222-8222-222222222222",
      batchId: "33333333-3333-4333-8333-333333333333",
    };
    snapshot.threads = [
      makeThread("thread-1", { session_id: scope.sessionId, artifact_id: scope.artifactId }),
    ];
    const view = render(
      panel({ sessionId: scope.sessionId, artifactId: scope.artifactId, anchor }),
    );
    await selectThread(user);
    await screen.findByText("Please explain the retry policy.");
    const composer = screen.getByLabelText("Comment", { exact: true });
    const reply = screen.getByLabelText("Reply to thread");
    await user.type(composer, "Keep my new comment draft.");
    await user.type(reply, "Keep my reply draft.");
    const threadButton = screen.getByRole("button", { name: /Discussion · open/ });
    expect(within(threadButton).getByText("Not submitted")).toBeVisible();
    const initialRequests = fetchMock.mock.calls.length;
    await act(async () => {
      publishArtifactFeedbackSubmission({
        ...scope,
        sessionId: "44444444-4444-4444-8444-444444444444",
      });
      publishArtifactFeedbackSubmission({
        ...scope,
        artifactId: "55555555-5555-4555-8555-555555555555",
      });
      window.dispatchEvent(
        new CustomEvent("wallie:artifact-feedback-submitted", {
          detail: { ...scope, batchId: null },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("wallie:artifact-feedback-submitted", {
          detail: { ...scope, extra: "unexpected" },
        }),
      );
    });
    expect(fetchMock.mock.calls).toHaveLength(initialRequests);

    snapshot.submittedThreadRevisions = { "thread-1": 1 };
    await act(async () => publishArtifactFeedbackSubmission(scope));
    await waitFor(() => expect(within(threadButton).getByText("Submitted")).toBeVisible());
    expect(fetchMock.mock.calls).toHaveLength(initialRequests + 1);
    expect(threadButton).toHaveAttribute("aria-current", "true");
    expect(composer).toHaveValue("Keep my new comment draft.");
    expect(reply).toHaveValue("Keep my reply draft.");

    // A late acknowledgement must re-read current revisions, not mark a later
    // edit submitted merely because an older batch was accepted.
    snapshot.threads = [
      makeThread("thread-1", {
        session_id: scope.sessionId,
        artifact_id: scope.artifactId,
        revision: 2,
      }),
    ];
    await act(async () => publishArtifactFeedbackSubmission(scope));
    await waitFor(() => expect(within(threadButton).getByText("Unsent changes")).toBeVisible());
    expect(composer).toHaveValue("Keep my new comment draft.");
    expect(reply).toHaveValue("Keep my reply draft.");
    const finalRequests = fetchMock.mock.calls.length;
    view.unmount();
    publishArtifactFeedbackSubmission(scope);
    expect(fetchMock.mock.calls).toHaveLength(finalRequests);
  });

  it("keeps an accepted coverage refresh authoritative when another page is requested", async () => {
    const user = userEvent.setup();
    const scope = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      artifactId: "22222222-2222-4222-8222-222222222222",
      batchId: "33333333-3333-4333-8333-333333333333",
    };
    snapshot.threads = [
      makeThread("thread-1", { session_id: scope.sessionId, artifact_id: scope.artifactId }),
    ];
    snapshot.nextCursor = { createdAt: "2026-11-05T00:00:00Z", id: "thread-1" };
    render(panel({ sessionId: scope.sessionId, artifactId: scope.artifactId }));
    await selectThread(user);
    await screen.findByText("Please explain the retry policy.");
    const reply = screen.getByLabelText("Reply to thread");
    await user.type(reply, "Keep this selection and draft.");
    const loadMore = screen.getByRole("button", { name: "Load more threads" });
    const normalFetch = fetchMock.getMockImplementation()!;
    let completeRefresh!: (response: Response) => void;
    let cursorRequests = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input, "https://wallie.test");
      if (url.pathname.endsWith("/reviews")) {
        if (url.searchParams.has("cursorId")) {
          cursorRequests++;
          return Response.json({
            ...snapshot,
            threads: [makeThread("thread-2")],
            submittedThreadRevisions: {},
            nextCursor: null,
          });
        }
        return new Promise<Response>((resolve) => {
          completeRefresh = resolve;
        });
      }
      return normalFetch(input, init);
    });
    await act(async () => {
      publishArtifactFeedbackSubmission(scope);
      fireEvent.click(loadMore);
    });
    expect(cursorRequests).toBe(0);
    expect(loadMore).toBeDisabled();
    snapshot.submittedThreadRevisions = { "thread-1": 1 };
    await act(async () => completeRefresh(Response.json(snapshot)));
    const selected = screen.getByRole("button", { name: /Discussion · open.*Alex/ });
    expect(within(selected).getByText("Submitted")).toBeVisible();
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(reply).toHaveValue("Keep this selection and draft.");
    await user.click(loadMore);
    expect(cursorRequests).toBe(1);
    expect(
      within(screen.getByRole("button", { name: /Submitted/ })).getByText("Submitted"),
    ).toBeVisible();
    expect(reply).toHaveValue("Keep this selection and draft.");
  });

  it("keeps cached submission coverage unknown if the accepted-receipt refresh fails", async () => {
    const scope = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      artifactId: "22222222-2222-4222-8222-222222222222",
      batchId: "33333333-3333-4333-8333-333333333333",
    };
    render(panel({ sessionId: scope.sessionId, artifactId: scope.artifactId }));
    const thread = await screen.findByRole("button", { name: /Discussion · open/ });
    expect(within(thread).getByText("Not submitted")).toBeVisible();
    fetchMock.mockResolvedValue(
      Response.json({ error: "Coverage refresh interrupted." }, { status: 503 }),
    );
    await act(async () => publishArtifactFeedbackSubmission(scope));
    await screen.findByText(/Coverage refresh interrupted/);
    expect(within(thread).queryByText("Not submitted")).toBeNull();
    expect(within(thread).getByText("Submission status unavailable")).toBeVisible();
  });

  it("distinguishes submitted threads from later unsent edits and new comments", async () => {
    snapshot.threads = [
      makeThread("submitted"),
      makeThread("edited", { revision: 2 }),
      makeThread("new"),
    ];
    snapshot.submittedThreadRevisions = { submitted: 1, edited: 1 };
    render(panel());
    await screen.findByText("Submitted");
    expect(screen.getByText("Unsent changes")).toBeVisible();
    expect(screen.getByText("Not submitted")).toBeVisible();
  });
  it("focuses an anchored composer and keeps an unchanged failed draft's idempotency key on retry", async () => {
    const user = userEvent.setup();
    saveFailures = 1;
    render(panel({ anchor }));
    const composer = await screen.findByLabelText("Comment", { exact: true });
    await waitFor(() => expect(composer).toHaveFocus());
    await user.type(composer, "Keep this feedback if the network fails.");
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("draft is retained");
    expect(composer).toHaveValue("Keep this feedback if the network fails.");
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(clearAnchor).toHaveBeenCalledOnce());
    expect(saves).toHaveLength(2);
    expect(saves[1]!.body).toEqual(saves[0]!.body);
    expect(saves[0]!.body.requestId).toEqual(expect.any(String));
    expect(saves[0]!.body.anchor).toEqual(anchor);
    expect(composer).toHaveValue("");
  });

  it("retains the exact request key after a network error with an unknown save outcome", async () => {
    const user = userEvent.setup();
    networkFailures = 1;
    render(panel({ anchor }));
    await user.type(await screen.findByLabelText("Comment", { exact: true }), "Network retry");
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(clearAnchor).toHaveBeenCalledOnce());
    expect(saves[1]!.body).toEqual(saves[0]!.body);
  });

  it("refreshes a confirmed stale edit and rebuilds its revision and request key without losing the draft", async () => {
    const user = userEvent.setup();
    saveFailures = 1;
    failureStatus = 409;
    render(panel());
    await selectThread(user);
    await user.click(screen.getByRole("button", { name: "Edit comment" }));
    const editor = screen.getByLabelText("Edit your comment");
    await user.clear(editor);
    await user.type(editor, "Keep my edited prose");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save edit" })).toBeEnabled());
    expect(editor).toHaveValue("Keep my edited prose");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[0]!.body.expectedRevision).toBe(1);
    expect(saves[1]!.body.expectedRevision).toBe(2);
    expect(saves[1]!.body.requestId).not.toBe(saves[0]!.body.requestId);
    expect(saves[1]!.body.body).toBe("Keep my edited prose");
  });

  it("uses a new idempotency key when the failed draft is changed", async () => {
    const user = userEvent.setup();
    saveFailures = 1;
    render(panel({ anchor }));
    const composer = await screen.findByLabelText("Comment", { exact: true });
    await user.type(composer, "Original feedback");
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    await screen.findByRole("alert");
    await user.type(composer, " with clarification");
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(clearAnchor).toHaveBeenCalledOnce());
    expect(saves[1]!.body.requestId).not.toBe(saves[0]!.body.requestId);
  });

  it("renders hostile comment text as text and only offers edits for the current author", async () => {
    const user = userEvent.setup();
    comments = [
      makeComment("mine", { body: '<img src=x onerror="alert(1)">' }),
      makeComment("theirs", {
        author_member_id: "member-2",
        author_label: "Sam",
        body: "Other reviewer",
      }),
    ];
    render(panel());
    await selectThread(user);
    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Edit comment" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Edit comment" }));
    const editor = screen.getByLabelText("Edit your comment");
    expect(editor).toHaveFocus();
    await user.clear(editor);
    await user.type(editor, "Updated comment");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      method: "PATCH",
      body: { commentId: "mine", expectedRevision: 1, body: "Updated comment" },
    });
  });

  it("keeps an edit target when realtime refresh drops the comment's later page", async () => {
    const user = userEvent.setup();
    realtime.enabled = true;
    const responder = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      const url = new URL(input, "https://wallie.test");
      if (!init?.method && url.pathname.endsWith("/comments")) {
        return Promise.resolve(
          Response.json(
            url.searchParams.has("cursorId")
              ? {
                  comments: [
                    makeComment("later-comment", {
                      revision: 7,
                      body: "Comment on the later page",
                    }),
                  ],
                  nextCursor: null,
                }
              : {
                  comments: [makeComment("first-comment", { author_member_id: "member-2" })],
                  nextCursor: { createdAt: "2026-11-05T00:00:00Z", id: "first-comment" },
                },
          ),
        );
      }
      return responder(input, init);
    });
    render(panel());
    await selectThread(user);
    await user.click(screen.getByRole("button", { name: "Load more comments" }));
    await user.click(await screen.findByRole("button", { name: "Edit comment" }));
    const editor = screen.getByLabelText("Edit your comment");
    await user.clear(editor);
    await user.type(editor, "An edit that must remain an edit");
    await act(async () => realtime.event?.());
    await waitFor(() => expect(screen.queryByText("Comment on the later page")).toBeNull());
    expect(editor).toHaveValue("An edit that must remain an edit");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      method: "PATCH",
      body: { commentId: "later-comment", expectedRevision: 7 },
    });
  });

  it("recovers a stale later-page edit by fetching that exact comment before retrying", async () => {
    const user = userEvent.setup();
    saveFailures = 1;
    failureStatus = 409;
    const responder = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      const url = new URL(input, "https://wallie.test");
      if (!init?.method && url.pathname.endsWith("/comments")) {
        if (url.searchParams.get("commentId") === "later-comment") {
          return Promise.resolve(
            Response.json({
              comments: [
                makeComment("later-comment", { revision: 8, body: "Concurrent edit on page two" }),
              ],
              nextCursor: null,
            }),
          );
        }
        return Promise.resolve(
          Response.json(
            url.searchParams.has("cursorId")
              ? {
                  comments: [
                    makeComment("later-comment", {
                      revision: 7,
                      body: "Later page original comment",
                    }),
                  ],
                  nextCursor: null,
                }
              : {
                  comments: [makeComment("first-comment", { author_member_id: "member-2" })],
                  nextCursor: { createdAt: "2026-11-05T00:00:00Z", id: "first-comment" },
                },
          ),
        );
      }
      return responder(input, init);
    });
    render(panel());
    await selectThread(user);
    await user.click(screen.getByRole("button", { name: "Load more comments" }));
    await user.click(await screen.findByRole("button", { name: "Edit comment" }));
    const editor = screen.getByLabelText("Edit your comment");
    await user.clear(editor);
    await user.type(editor, "My preserved page-two edit");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save edit" })).toBeEnabled());
    expect(editor).toHaveValue("My preserved page-two edit");
    expect(await screen.findByText("Concurrent edit on page two")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[0]).toMatchObject({
      method: "PATCH",
      body: { commentId: "later-comment", expectedRevision: 7 },
    });
    expect(saves[1]).toMatchObject({
      method: "PATCH",
      body: { commentId: "later-comment", expectedRevision: 8, body: "My preserved page-two edit" },
    });
    expect(saves[1]!.body.requestId).not.toBe(saves[0]!.body.requestId);
  });

  it("stashes the current thread draft before opening a newly created thread", async () => {
    const user = userEvent.setup();
    const view = render(panel());
    await selectThread(user);
    await user.type(screen.getByLabelText("Reply to thread"), "Draft for the original thread");
    view.rerender(panel({ anchor }));
    await user.type(
      await screen.findByLabelText("Comment", { exact: true }),
      "Start another thread",
    );
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Thread link" })).toHaveAttribute(
        "href",
        expect.stringContaining("reviewThread=saved-thread"),
      ),
    );
    expect(screen.getByLabelText("Reply to thread")).toHaveValue("");
    await user.click(screen.getAllByRole("button", { name: /Discussion · open/ })[0]!);
    expect(screen.getByLabelText("Reply to thread")).toHaveValue("Draft for the original thread");
  });

  it("makes archived historical artifacts readable without any write controls", async () => {
    const user = userEvent.setup();
    snapshot.viewer.readOnlyReason = "archived";
    render(panel({ anchor, historical: true }));
    expect(
      await screen.findByText("This session is archived. Comments are read-only."),
    ).toBeVisible();
    expect(screen.getByText("Version 1 · Historical artifact")).toBeVisible();
    await user.click(await screen.findByRole("button", { name: /Discussion · open/ }));
    expect(await screen.findByText("Please explain the retry policy.")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();
  });

  it("immediately removes write controls when the live parent marks the session archived", async () => {
    const view = render(panel({ anchor }));
    expect(await screen.findByLabelText("Comment", { exact: true })).toBeVisible();
    view.rerender(panel({ anchor, readOnlyReason: "archived" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("This session is archived. Comments are read-only.")).toBeVisible();
  });

  it("describes approved, unarchived artifacts without claiming archival", async () => {
    const user = userEvent.setup();
    snapshot.viewer.readOnlyReason = "approved";
    render(panel({ anchor }));
    expect(
      await screen.findByText("This session is approved. Comments are read-only."),
    ).toBeVisible();
    expect(screen.queryByText(/This session is archived/)).toBeNull();
    await user.click(await screen.findByRole("button", { name: /Discussion · open/ }));
    expect(await screen.findByText("Please explain the retry policy.")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();
    expect(saves).toHaveLength(0);
  });

  it.each([401, 403])("withholds authoring when permission lookup returns %s", async (status) => {
    fetchMock.mockResolvedValue(Response.json({ error: "Review access denied." }, { status }));
    render(panel({ anchor }));
    expect(
      await screen.findByText("You do not have permission to comment on this artifact."),
    ).toBeVisible();
    expect(screen.queryByText(/This session is archived/)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save comment" })).toBeNull();
    expect(saves).toHaveLength(0);
  });

  it("withholds authoring during permission loading and recovers after a failed lookup", async () => {
    const user = userEvent.setup();
    let resolve: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    render(panel({ anchor }));
    expect(screen.queryByRole("textbox")).toBeNull();
    await act(async () =>
      resolve?.(Response.json({ error: "Review unavailable." }, { status: 503 })),
    );
    expect(
      await screen.findByText(
        "Comments are unavailable until permissions can be verified. Retry loading comments.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry loading" }));
    expect(await screen.findByLabelText("Comment", { exact: true })).toBeVisible();
  });

  it("retains the new-comment draft and exact anchor through a live read-only transition", async () => {
    const user = userEvent.setup();
    const view = render(panel({ anchor }));
    await user.type(
      await screen.findByLabelText("Comment", { exact: true }),
      "Keep this exact draft",
    );
    view.rerender(panel({ anchor, readOnlyReason: "approved" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("This session is approved. Comments are read-only.")).toBeVisible();
    view.rerender(panel({ anchor }));
    expect(await screen.findByLabelText("Comment", { exact: true })).toHaveValue(
      "Keep this exact draft",
    );
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]?.body).toMatchObject({
      artifactId: "artifact-1",
      artifactVersion: 1,
      anchor,
      body: "Keep this exact draft",
    });
  });

  it("retains an unsaved reply through a realtime update and refreshes persisted comments", async () => {
    const user = userEvent.setup();
    realtime.enabled = true;
    const view = render(panel());
    await selectThread(user);
    const reply = screen.getByLabelText("Reply to thread");
    await user.type(reply, "Draft stays here");
    comments = [
      ...comments,
      makeComment("new", {
        author_member_id: "member-2",
        author_label: "Sam",
        body: "Second reviewer replied",
      }),
    ];
    await act(async () => realtime.event?.());
    expect(await screen.findByText("Second reviewer replied")).toBeVisible();
    expect(reply).toHaveValue("Draft stays here");
    expect(realtime.filter).toBe("session_id=eq.session-1");
    await act(async () => realtime.status?.("SUBSCRIBED"));
    expect(reply).toHaveValue("Draft stays here");
    view.unmount();
    expect(realtime.remove).toHaveBeenCalledOnce();
  });

  it("restores focus to the opener when comments close", async () => {
    const user = userEvent.setup();
    const openerRef = createRef<HTMLButtonElement>();
    const close = vi.fn();
    render(
      <>
        <button ref={openerRef}>Open comments</button>
        {panel({ openerRef, onClose: close })}
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(openerRef.current).toHaveFocus());
    expect(close).toHaveBeenCalledOnce();
  });

  it("opens an explicit blocking source independently of the selected reader thread", async () => {
    window.history.replaceState({}, "", "/w/acme/sessions/session-1?reviewThread=unrelated-thread");
    render(
      panel({
        initialThreadId: "deep-thread",
        panelId: "review-evidence-comments",
        syncLocation: false,
      }),
    );
    const selected = await screen.findByRole("region", { name: "Selected review thread" });
    expect(within(selected).getByRole("link", { name: "Thread link" })).toHaveAttribute(
      "href",
      expect.stringContaining("reviewThread=deep-thread"),
    );
    expect(document.getElementById("review-evidence-comments")).toBeTruthy();
    expect(within(selected).getByRole("link", { name: "Thread link" })).toHaveAttribute(
      "href",
      expect.stringContaining("artifactStage=plan"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Discussion · open/ })[0]!);
    expect(window.location.search).toBe("?reviewThread=unrelated-thread");
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith("/reviews/deep-thread")),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith("/reviews/unrelated-thread")),
    ).toBe(false);
  });

  it("restores the blocker on each source activation while preserving per-thread drafts", async () => {
    snapshot.threads = [
      makeThread("thread-1"),
      makeThread("blocking-thread", { kind: "blocking" }),
    ];
    const sourcePanel = (revision: number) =>
      panel({
        initialThreadId: "blocking-thread",
        sourceSelectionRevision: revision,
        syncLocation: false,
        panelId: "review-evidence-comments",
      });
    const view = render(sourcePanel(1));
    const selected = await screen.findByRole("region", { name: "Selected review thread" });
    await waitFor(() =>
      expect(within(selected).getByRole("link", { name: "Thread link" })).toHaveAttribute(
        "href",
        expect.stringContaining("reviewThread=blocking-thread"),
      ),
    );
    fireEvent.change(screen.getByLabelText("Reply to thread"), {
      target: { value: "Blocker draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Discussion · open/ }));
    fireEvent.change(screen.getByLabelText("Reply to thread"), {
      target: { value: "Discussion draft" },
    });

    view.rerender(sourcePanel(2));

    await waitFor(() =>
      expect(within(selected).getByRole("link", { name: "Thread link" })).toHaveAttribute(
        "href",
        expect.stringContaining("reviewThread=blocking-thread"),
      ),
    );
    expect(screen.getByLabelText("Reply to thread")).toHaveValue("Blocker draft");
    fireEvent.click(screen.getByRole("button", { name: /Discussion · open/ }));
    expect(screen.getByLabelText("Reply to thread")).toHaveValue("Discussion draft");
  });

  it("deep links to a thread beyond the initial page without loading all thread history", async () => {
    window.history.replaceState({}, "", "/w/acme/sessions/session-1?reviewThread=deep-thread");
    render(panel());
    const selected = await screen.findByRole("region", { name: "Selected review thread" });
    expect(within(selected).getByRole("link", { name: "Thread link" })).toHaveAttribute(
      "href",
      expect.stringContaining("reviewThread=deep-thread"),
    );
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith("/reviews/deep-thread")),
    ).toBe(true);
  });

  it.each([
    { revision: 3, label: "Submitted" },
    { revision: null, label: "Not submitted" },
    { revision: undefined, label: "Submission status unavailable" },
  ])(
    "uses verified single-thread coverage for a deep link: $label",
    async ({ revision, label }) => {
      window.history.replaceState({}, "", "/w/acme/sessions/session-1?reviewThread=deep-thread");
      snapshot.threads = Array.from({ length: 20 }, (_, index) =>
        makeThread(`first-page-${index}`),
      );
      snapshot.nextCursor = { createdAt: "2026-11-05T00:00:00Z", id: "first-page-19" };
      const normalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) =>
        String(input).endsWith("/reviews/deep-thread")
          ? Response.json({
              thread: makeThread("deep-thread", { author_label: "Deep reviewer", revision: 3 }),
              submittedThreadRevision: revision,
            })
          : normalFetch(input, init),
      );
      render(panel());
      const deepLink = await screen.findByRole("button", { name: /Deep reviewer/ });
      expect(within(deepLink).getByText(label)).toBeVisible();
      if (label !== "Not submitted")
        expect(within(deepLink).queryByText("Not submitted")).toBeNull();
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).includes("cursorId=")),
      ).toHaveLength(0);
    },
  );

  it("retains verified submitted coverage on earlier pages when loading more threads", async () => {
    const user = userEvent.setup();
    snapshot.threads = [makeThread("first", { author_label: "First reviewer" })];
    snapshot.submittedThreadRevisions = { first: 1 };
    snapshot.nextCursor = { createdAt: "2026-11-05T00:00:00Z", id: "first" };
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      new URL(input, "https://wallie.test").searchParams.has("cursorId")
        ? Response.json({
            ...snapshot,
            threads: [makeThread("second", { author_label: "Second reviewer" })],
            submittedThreadRevisions: { second: 1 },
            nextCursor: null,
          })
        : normalFetch(input, init),
    );
    render(panel());
    await screen.findByRole("button", { name: /First reviewer/ });
    await user.click(screen.getByRole("button", { name: "Load more threads" }));
    await screen.findByRole("button", { name: /Second reviewer/ });
    expect(
      within(screen.getByRole("button", { name: /First reviewer/ })).getByText("Submitted"),
    ).toBeVisible();
    expect(
      within(screen.getByRole("button", { name: /Second reviewer/ })).getByText("Submitted"),
    ).toBeVisible();
  });

  it("requires a human-entered reason and reviewer authority to resolve a blocking request", async () => {
    const user = userEvent.setup();
    snapshot.threads = [makeThread("thread-1", { kind: "blocking" })];
    snapshot.viewer.canReview = true;
    render(panel());
    await user.click(await screen.findByRole("button", { name: /Blocking request · open/ }));
    const resolve = screen.getByRole("button", { name: "Resolve thread" });
    expect(resolve).toBeDisabled();
    await user.type(
      screen.getByLabelText("Reason for changing thread status"),
      "Verified the revision",
    );
    await user.click(resolve);
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      method: "PATCH",
      body: { expectedRevision: 1, status: "resolved", reason: "Verified the revision" },
    });
  });
});
