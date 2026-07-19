import { expect, test } from "@playwright/test";

import { signIn } from "../helpers/auth";
import { expectNoSeriousAxeViolations, expectNamedInteractiveControls } from "../helpers/axe";
import { REGRESSION_ROUTES } from "../helpers/fixtures";
import {
  expectNoUnintendedHorizontalOverflow,
  expectSingleDocumentScroller,
} from "../helpers/overflow";
import {
  applyTheme,
  REGRESSION_VIEWPORTS,
  settleForScreenshot,
  THEMES,
  type Theme,
} from "../helpers/theme";

test.describe("visual / axe / overflow regression matrix", () => {
  test.describe.configure({ mode: "serial" });

  test("route × theme × viewport baselines stay stable with a11y and overflow gates", async ({
    page,
  }) => {
    test.setTimeout(12 * 60_000);

    let signedIn = false;
    for (const viewport of REGRESSION_VIEWPORTS) {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });

      for (const theme of THEMES) {
        for (const route of REGRESSION_ROUTES) {
          if (route.auth && !signedIn) {
            await signIn(page, route.path);
            signedIn = true;
          } else if (route.auth) {
            await page.goto(route.path);
          } else {
            await page.goto(route.path);
          }

          await applyTheme(page, theme as Theme);
          await settleForScreenshot(page);
          await expectSingleDocumentScroller(page);
          await expectNoUnintendedHorizontalOverflow(page);
          await expectNoSeriousAxeViolations(page);
          await expectNamedInteractiveControls(page);

          await expect(page).toHaveScreenshot(`${route.name}-${viewport.name}-${theme}.png`, {
            animations: "disabled",
            caret: "hide",
            // Viewport-sized captures match the required 390×844 / 1440×1000 matrix and
            // stay dimension-stable across darwin/linux font metrics (unlike fullPage).
            fullPage: false,
            maxDiffPixelRatio: 0.04,
          });
        }
      }
    }
  });
});
