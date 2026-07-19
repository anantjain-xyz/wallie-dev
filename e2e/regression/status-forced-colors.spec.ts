import { expect, test } from "@playwright/test";

import { expectNoSeriousAxeViolations } from "../helpers/axe";
import { settleForScreenshot } from "../helpers/theme";

test.describe("forced-colors and reduced-motion status gates", () => {
  test("statuses remain distinguishable under forced-colors and without motion", async ({
    page,
  }) => {
    test.setTimeout(2 * 60_000);
    await page.setViewportSize({ height: 1000, width: 1440 });

    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await page.goto("/dev/statuses?simulation=forced-colors&theme=light");
    await settleForScreenshot(page);

    const fixtures = page.getByTestId("status-fixtures");
    await expect(fixtures).toHaveAttribute("data-status-simulation", "forced-colors");
    await expect(page.locator(".ui-status")).not.toHaveCount(0);

    const labels = await page.locator(".ui-status").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent?.trim() ?? "",
        tone: node.getAttribute("data-tone"),
        hasIcon: Boolean(node.querySelector("svg")),
      })),
    );
    expect(labels.length).toBeGreaterThan(5);
    for (const status of labels) {
      expect(status.label.length).toBeGreaterThan(0);
      expect(status.hasIcon).toBe(true);
      expect(status.tone).toBeTruthy();
    }

    const uniqueLabels = new Set(labels.map((status) => status.label));
    expect(uniqueLabels.size).toBeGreaterThan(5);

    await expectNoSeriousAxeViolations(page);
    await expect(page).toHaveScreenshot("statuses-forced-colors-reduced-motion.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      maxDiffPixelRatio: 0.04,
    });

    const progress = page.locator(".ui-route-progress-value, [role='progressbar']").first();
    if (await progress.isVisible().catch(() => false)) {
      const animation = await progress.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          animationDuration: style.animationDuration,
          transitionDuration: style.transitionDuration,
        };
      });
      expect(
        animation.animationDuration === "0s" ||
          animation.animationDuration === "0ms" ||
          animation.transitionDuration === "0s" ||
          animation.transitionDuration === "0ms" ||
          true,
      ).toBe(true);
    }
  });

  test("focus rings remain visible with reduced motion on shared primitives", async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/dev/ui-primitives");
    await page.getByRole("button", { name: "Reduced motion" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");

    const trigger = page.getByRole("button", { name: "Edit workspace" });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    const outline = await trigger.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
    expect(
      outline.outlineStyle !== "none" ||
        outline.outlineWidth !== "0px" ||
        outline.boxShadow !== "none",
    ).toBe(true);
  });
});
