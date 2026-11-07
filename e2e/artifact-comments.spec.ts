import { expect, test } from "@playwright/test";

const previewPath = "/dev/interaction-motion?artifactId=artifact-preview";
const snapshot = {
  reviewRevision: 1,
  submittedThreadRevisions: {},
  threads: [],
  nextCursor: null,
  counts: { total: 0, open: 0, blocking: 0 },
  viewer: { memberId: "reviewer", canReview: true, readOnly: false },
};

test.beforeEach(async ({ page }) => {
  // Exercise the real artifact reader without creating sessions or workspace data.
  await page.route("**/api/sessions/preview/artifacts?*", (route) =>
    route.fulfill({
      json: {
        artifact: {
          id: "artifact-preview",
          createdAt: "2026-11-07T12:00:00Z",
          stageSlug: "build",
          version: 1,
          payload: "# Goal\n\nRetain changes.",
          sanitizedHtml:
            '<h2>Goal</h2><p><span data-review-text-start="8" data-review-text-end="23">Retain changes.</span></p>',
        },
      },
    }),
  );
  await page.route("**/api/sessions/preview/reviews?*", (route) =>
    route.fulfill({ json: snapshot }),
  );
});

for (const width of [1440, 390]) {
  test(`comments collapse, restore focus, and retain drafts at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(previewPath);
    const show = page.getByRole("button", { name: "Show comments", exact: true });
    const collapse = page.getByRole("button", { name: "Collapse comments", exact: true });
    const panel = page.locator("#artifact-review-panel");
    await expect(show).toBeVisible();
    await expect(panel).toHaveCount(0);
    const toolbar = show.locator("..");
    const buttonBox = await show.boundingBox();
    const toolbarBox = await toolbar.boundingBox();
    expect(
      Math.abs(buttonBox!.x + buttonBox!.width - toolbarBox!.x - toolbarBox!.width),
    ).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath("collapsed.png"), fullPage: true });

    await show.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByText("0 open · 0 blocking requests")).toBeVisible();
    await expect(show).toHaveCount(0);
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await expect(collapse).toHaveAttribute("aria-controls", "artifact-review-panel");
    await page.screenshot({ path: testInfo.outputPath("expanded-empty.png"), fullPage: true });
    await collapse.click();
    await expect(panel).toBeHidden();
    await expect(show).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("collapsed-focused.png"), fullPage: true });

    const text = page.locator("[data-review-text-start='8']");
    await text.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Comment on selection" }).click();
    const draft = panel.getByRole("textbox", { name: "Comment", exact: true });
    await expect(draft).toBeVisible();
    await draft.fill("Please preserve these changes.");
    await page.screenshot({ path: testInfo.outputPath("selection-composer.png"), fullPage: true });
    await collapse.click();
    await show.click();
    await expect(draft).toHaveValue("Please preserve these changes.");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
  });
}

test("comments can collapse during loading and after a failed request", async ({
  page,
}, testInfo) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/preview/reviews?*", async (route) => {
    await gate;
    await route.fulfill({ status: 503, json: { error: "Comments unavailable. Please retry." } });
  });
  try {
    await page.goto(previewPath);
    await page.getByRole("button", { name: "Show comments" }).click();
    const panel = page.locator("#artifact-review-panel");
    await expect(panel.getByText("Loading comments…")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("loading.png"), fullPage: true });
    await page.getByRole("button", { name: "Collapse comments" }).click();
    await expect(panel).toBeHidden();
    release();
    await page.getByRole("button", { name: "Show comments" }).click();
    await expect(panel.getByRole("alert")).toContainText("Comments unavailable");
    await page.screenshot({ path: testInfo.outputPath("error.png"), fullPage: true });
    await page.getByRole("button", { name: "Collapse comments" }).click();
    await expect(page.getByRole("button", { name: "Show comments" })).toBeFocused();
  } finally {
    release();
  }
});
