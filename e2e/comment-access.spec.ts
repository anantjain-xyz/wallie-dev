import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

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
  await mkdir(".symphony/screenshots", { recursive: true });
  await page.screenshot({ path: `.symphony/screenshots/${name}.png`, fullPage: true });
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
      const notice = `This session is ${state}. Comments are read-only.`;
      await expect(page.getByText("0 open · 0 blocking requests")).toBeVisible();
      await expect(page.getByText(notice, { exact: true })).toHaveCount(2);
      await expect(page.getByText(notice).first()).toBeVisible();
      if (state === "approved") {
        await expect(
          page.getByText("This session is archived. Comments are read-only."),
        ).toHaveCount(0);
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
  await expect(
    page.getByText("This request blocks approval until a reviewer closes it."),
  ).toBeVisible();
  await capture(page, "06-editable-keyboard-composer");
  await composer.press("Escape");
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await expect(composer).toHaveValue("Retain this draft across panel visibility changes.");
  await page.getByRole("button", { name: "Cancel new comment" }).click();
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
  await expect(
    page.getByText("You do not have permission to comment on this artifact.").first(),
  ).toBeVisible();
  await expectNoAuthoring(page);
  await capture(page, "10-comment-permissions-unauthorized");
});
