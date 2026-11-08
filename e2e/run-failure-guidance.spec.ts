import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const explanations = [
  [
    "configuration",
    "The sandbox connection is missing, invalid, or needs a fresh capability check.",
  ],
  ["agent-exit", "The agent process exited unsuccessfully before completing the run."],
  ["timeout", "The run exceeded its time limit or stopped reporting activity."],
  ["budget", "The session's execution budget was exhausted"],
  ["publication", "Wallie could not preserve or publish the run's output for review."],
  ["legacy", "Failure cause unavailable"],
];

for (const width of [1440, 390]) {
  test(`persisted failure guidance survives collapsed and expanded activity at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const response = await page.goto("/dev/run-failures");
    expect(await response?.text()).not.toContain("fixture-secret-that-must-stay-private");
    expect(await response?.text()).not.toContain("fixture-api-key-that-must-stay-private");
    await expect(page.getByRole("heading", { name: "Run failure explanations" })).toBeVisible();
    for (const [id, cause] of explanations) {
      const card = page.locator(`[data-failure-scenario="${id}"]`);
      await expect(card).toContainText(cause);
      await expect(
        card.getByRole("button", { name: "Build run activity: Failed" }),
      ).toHaveAttribute("aria-expanded", "false");
    }
    const success = page.locator('[data-failure-scenario="success"]');
    await expect(success).toContainText("Completed");
    await expect(success).not.toContainText("Failure cause unavailable");
    await expect(page.getByRole("list", { name: "Run activity" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText('"version":1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await mkdir(".symphony/screenshots", { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `.symphony/screenshots/${width}-failure-guidance-collapsed.png`,
      fullPage: true,
    });

    for (const button of await page.getByRole("button", { name: /Build run activity:/ }).all()) {
      await button.click();
    }
    for (const [id, cause] of explanations) {
      const card = page.locator(`[data-failure-scenario="${id}"]`);
      await expect(card).toContainText(cause);
      if (id !== "legacy") {
        await expect(card.getByText("Activity error details", { exact: true })).toBeVisible();
        await expect(card.getByText(/Provider request failed/)).not.toBeVisible();
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `.symphony/screenshots/${width}-failure-guidance-activity-expanded.png`,
      fullPage: true,
    });

    for (const summary of await page
      .locator("summary")
      .filter({ hasText: /^(Run details|Activity error details)$/ })
      .all()) {
      await summary.click();
    }
    for (const [id, cause] of explanations) {
      const card = page.locator(`[data-failure-scenario="${id}"]`);
      await expect(card).toContainText(cause);
      await expect(card.getByText("Run ID", { exact: true })).toBeVisible();
    }
    await expect(
      success.getByText("Tests failed on the first attempt; I’m checking the assertions.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(success.getByRole("status")).toHaveText("Completed");
    await expect(
      success.getByText(
        "Tests failed during development; the agent fixed them before completing the run.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(success).not.toContainText("Failure cause unavailable");
    await expect(page.locator("body")).not.toContainText("fixture-secret-that-must-stay-private");
    await expect(page.locator("body")).not.toContainText("fixture-api-key-that-must-stay-private");
    await expect(
      page.locator('[data-failure-scenario="configuration"]').getByText(/Provider request failed/),
    ).toHaveText(
      "Provider request failed (403). Authorization: Bearer [redacted]; api_key=[redacted]",
    );
    await expect(page.locator("body")).not.toContainText('"version":1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `.symphony/screenshots/${width}-failure-guidance-expanded.png`,
      fullPage: true,
    });
  });
}
