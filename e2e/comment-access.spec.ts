import { mkdir } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

import { z } from "zod";
import { createArtifactSourceAnchor } from "../src/features/sessions/review/source-anchor";
import type {
  ArtifactReviewComment,
  ArtifactReviewThread,
  ReviewThreadListPayload,
} from "../src/features/sessions/review/types";

type SessionState = "editable" | "approved" | "archived";

function reviewSnapshot(state: SessionState) {
  return {
    reviewRevision: 0,
    submittedThreadRevisions: {},
    threads: [],
    nextCursor: null,
    counts: { total: 0, open: 0, blocking: 0 },
    viewer: {
      memberId: "22222222-2222-4222-8222-222222222222",
      canReview: false,
      readOnlyReason: state === "editable" ? null : state,
    },
  };
}

async function openFixture(page: Page, state: SessionState) {
  await page.goto(`/dev/interaction-motion?reviewState=${state}`);
  await expect(
    page.getByText(
      `Session fixture: ${state === "editable" ? "Editable" : "Approved"} · ${state === "archived" ? "Archived" : "Unarchived"}`,
    ),
  ).toBeVisible();
  const comments = page.getByRole("button", { name: "Comments", exact: true });
  await comments.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close comments" })).toBeVisible();
  return comments;
}

async function capture(page: Page, name: string) {
  await mkdir(".wallie/screenshots", { recursive: true });
  await page.screenshot({ path: `.wallie/screenshots/${name}.png`, fullPage: true });
}

async function selectPassage(page: Page, event: "keyup" | "pointerup") {
  const passage = page.locator("p[data-review-text-start]");
  await passage.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await passage.dispatchEvent(event, event === "keyup" ? { key: "Shift" } : {});
}

async function expectNoAuthoring(page: Page, loading = false) {
  const add = page.getByRole("button", { name: "Add comment", exact: true });
  if (await add.count()) await expect(add).toBeDisabled();
  await selectPassage(page, "keyup");
  await selectPassage(page, "pointerup");
  const selectionAction = page.getByRole("button", { name: "Comment on selection" });
  if (loading) {
    await expect(selectionAction).toBeDisabled();
    await expect(selectionAction).toHaveAccessibleDescription("Checking comment permissions…");
  } else {
    await expect(selectionAction).toHaveCount(0);
  }
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

for (const width of [1440, 390]) {
  for (const state of ["approved", "archived"] satisfies SessionState[]) {
    test(`${state} comments use the real read-only reason at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/sessions/preview/reviews?*", (route) =>
        route.fulfill({ json: reviewSnapshot(state) }),
      );
      const opener = await openFixture(page, state);
      const notice = `${state === "approved" ? "Approved" : "Archived"} · Comments are read-only.`;
      await expect(page.getByText("0 open · 0 blocking requests")).toBeVisible();
      await expect(page.getByText(notice, { exact: true })).toHaveCount(2);
      await expect(page.getByText(notice).first()).toBeVisible();
      if (state === "approved") {
        await expect(page.getByText("Archived · Comments are read-only.")).toHaveCount(0);
      }
      await expectNoAuthoring(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await capture(page, `${width === 1440 ? "01" : "03"}-${state}-${width}`);
      await page.getByRole("button", { name: "Close comments" }).click();
      await expect(opener).toBeFocused();
    });
  }
}

test("editable keyboard and selection comments retain drafts and version anchors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/sessions/preview/reviews?*", (route) =>
    route.fulfill({ json: reviewSnapshot("editable") }),
  );
  const opener = await openFixture(page, "editable");
  const block = page.getByLabel("Comment on a block");
  await expect(block).toBeEnabled();
  await capture(page, "05-editable-blocks-desktop");
  await block.selectOption("1");
  await block.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Add comment", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const composer = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(composer).toBeFocused();
  await expect(page.locator("blockquote")).toHaveText("Version 1 is ready for review.");
  await composer.fill("Retain this draft across panel visibility changes.");
  await page.getByLabel("Comment type").selectOption("blocking");
  await expect(page.getByText("Blocks approval until a reviewer closes it.")).toBeVisible();
  await capture(page, "06-editable-keyboard-composer");
  await composer.press("Escape");
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await expect(composer).toHaveValue("Retain this draft across panel visibility changes.");
  await page.getByRole("button", { name: "Discard" }).click();
  await selectPassage(page, "keyup");
  const selectionAction = page.getByRole("button", { name: "Comment on selection" });
  await expect(selectionAction).toBeVisible();
  await selectionAction.click();
  await expect(composer).toBeFocused();
  await expect(page.locator("blockquote")).toHaveText("Version 1 is ready for review.");
  await capture(page, "07-editable-selection-composer");
});

test("comment permissions stay unavailable while loading and recover after a failed lookup", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route("**/api/sessions/preview/reviews?*", async (route) => {
    await gate;
    await route.fulfill(
      fail
        ? { status: 503, json: { error: "Review service temporarily unavailable." } }
        : { json: reviewSnapshot("editable") },
    );
  });
  try {
    await openFixture(page, "editable");
    await expect(page.getByText("Checking comment permissions…").first()).toBeVisible();
    await expectNoAuthoring(page, true);
    await capture(page, "08-comment-permissions-loading");
    release();
    await expect(
      page.getByRole("alert").filter({ hasText: "Review service temporarily unavailable." }),
    ).toBeVisible();
    await expectNoAuthoring(page);
    await capture(page, "09-comment-permissions-unavailable");
    fail = false;
    await page.getByRole("button", { name: "Retry loading" }).click();
    await expect(page.getByRole("button", { name: "Add comment", exact: true })).toBeEnabled();
  } finally {
    release();
  }
});

test("unauthorized viewers have no keyboard or selection authoring action", async ({ page }) => {
  await page.route("**/api/sessions/preview/reviews?*", (route) =>
    route.fulfill({ status: 403, json: { error: "Active workspace membership is required." } }),
  );
  await openFixture(page, "editable");
  await expect(page.getByText("You don’t have permission to comment.").first()).toBeVisible();
  await expectNoAuthoring(page);
  await capture(page, "10-comment-permissions-unauthorized");
});

const artifactId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const source = "# Implementation complete\n\nVersion 1 is ready for review.";
const start = source.indexOf("Version");
const anchor = createArtifactSourceAnchor(source, start, source.length);
const thread: ArtifactReviewThread = {
  id: threadId,
  workspace_id: "44444444-4444-4444-8444-444444444444",
  session_id: "preview",
  artifact_id: artifactId,
  stage_id: "55555555-5555-4555-8555-555555555555",
  stage_slug: "build",
  artifact_version: 1,
  anchor,
  kind: "discussion",
  status: "open",
  author_member_id: memberId,
  author_label: "Alex",
  revision: 1,
  created_at: "2026-11-08T12:00:00Z",
  updated_at: "2026-11-08T12:00:00Z",
};
const comment: ArtifactReviewComment = {
  id: "66666666-6666-4666-8666-666666666666",
  workspace_id: thread.workspace_id,
  thread_id: threadId,
  author_member_id: memberId,
  author_label: "Alex",
  body: "Please explain the retry policy.",
  revision: 1,
  created_at: thread.created_at,
  updated_at: thread.updated_at,
};
function snapshot(reason: "approved" | "archived" | null = null): ReviewThreadListPayload {
  return {
    reviewRevision: 7,
    submittedThreadRevisions: {},
    threads: [thread],
    nextCursor: null,
    counts: { total: 1, open: 1, blocking: 0 },
    viewer: { memberId, canReview: true, readOnlyReason: reason },
  };
}
const apiPattern = /\/api\/sessions\/preview\/reviews(?:[/?].*)?$/;
const wsPattern = /\/realtime\/v1\/websocket/;
const phoenixMessage = z.tuple([
  z.string().nullable(),
  z.string().nullable(),
  z.string(),
  z.string(),
  z.unknown(),
]);
for (const width of [1440, 390]) {
  test(`failed permission refresh keeps retry after successful comments and restores reply at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    let acknowledge: (() => void) | undefined;
    await page.routeWebSocket(wsPattern, (socket) => {
      socket.onMessage((raw) => {
        if (typeof raw !== "string") return;
        const [joinRef, ref, topic, event] = phoenixMessage.parse(JSON.parse(raw));
        const reply = () =>
          socket.send(
            JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]),
          );
        if (event === "phx_join") acknowledge = reply;
        else if (event === "heartbeat") reply();
      });
    });
    let refreshing = false;
    let pendingComments: Route | undefined;
    const saves: unknown[] = [];
    await page.route(apiPattern, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST") {
        saves.push(request.postDataJSON());
        return route.fulfill({
          json: { comment: { ...comment, body: "Keep my exact reply draft." } },
        });
      }
      if (path.endsWith("/comments")) {
        if (refreshing) {
          pendingComments = route;
          return;
        }
        return route.fulfill({ json: { comments: [comment], nextCursor: null } });
      }
      if (refreshing)
        return route.fulfill({ status: 503, json: { error: "Permission refresh interrupted." } });
      return route.fulfill({ json: snapshot() });
    });
    await openFixture(page, "editable");
    await page.getByRole("button", { name: /Discussion · open/ }).click();
    const reply = page.getByLabel("Reply to thread");
    await reply.fill("Keep my exact reply draft.");
    await expect(page.getByText(comment.body, { exact: true })).toBeVisible();
    await expect.poll(() => Boolean(acknowledge)).toBe(true);
    refreshing = true;
    acknowledge?.();
    await expect(page.getByText("Permission refresh interrupted.", { exact: false })).toBeVisible();
    await expect.poll(() => Boolean(pendingComments)).toBe(true);
    const refreshedBody = "The comments refresh completed after the permission failure.";
    await pendingComments?.fulfill({
      json: { comments: [{ ...comment, body: refreshedBody }], nextCursor: null },
    });
    await expect(page.getByText(refreshedBody, { exact: true })).toBeVisible();
    await expect(page.getByText("Loading thread…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry loading" })).toBeVisible();
    await expect(page.getByText("Permission refresh interrupted.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add comment", exact: true })).toBeDisabled();
    await expect(reply).toHaveCount(0);
    await page.getByRole("heading", { name: "Session interaction preview" }).click();
    await capture(page, `11-permission-refresh-retry-${width}`);
    refreshing = false;
    await page.getByRole("button", { name: "Retry loading" }).click();
    await expect(reply).toHaveValue("Keep my exact reply draft.");
    await expect(page.getByRole("button", { name: "Reply" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Add comment", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Retry loading" })).toHaveCount(0);
    await page.getByRole("heading", { name: "Session interaction preview" }).click();
    await capture(page, `12-permission-refresh-recovered-${width}`);
    await page.getByRole("button", { name: "Reply" }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ body: "Keep my exact reply draft." });
  });
}
