import { expect, test } from "@playwright/test";

import { signIn } from "../helpers/auth";
import { expectNoSeriousAxeViolations } from "../helpers/axe";
import { REGRESSION_STATE_FIXTURES } from "../helpers/fixtures";
import {
  expectNoUnintendedHorizontalOverflow,
  expectSingleDocumentScroller,
} from "../helpers/overflow";
import { settleForScreenshot } from "../helpers/theme";

test.describe("deterministic state fixtures", () => {
  test("empty through complete fixtures resolve without overflow or serious axe issues", async ({
    page,
  }) => {
    test.setTimeout(6 * 60_000);
    await page.setViewportSize({ height: 1000, width: 1440 });

    let signedIn = false;

    for (const fixture of REGRESSION_STATE_FIXTURES) {
      if (fixture.requiresAuth && !signedIn) {
        await signIn(page, fixture.path);
        signedIn = true;
      } else if (fixture.requiresAuth) {
        await page.goto(fixture.path);
      } else {
        await page.goto(fixture.path);
      }

      if ("setup" in fixture && fixture.setup === "empty-section") {
        await expect(page.locator('[data-sessions-ledger-fixture="empty"]')).toBeVisible();
      }

      if ("setup" in fixture && fixture.setup === "validation-error") {
        await page.getByRole("button", { name: "New session" }).click();
        const linearField = page.getByLabel("Linear issue URL");
        await linearField.fill("https://example.com/not-linear");
        await linearField.blur();
        await expect(page.locator("#session-linear-error")).toBeVisible();
        await expectNoSeriousAxeViolations(page);
        await page.keyboard.press("Escape");
      }

      if ("setup" in fixture && fixture.setup === "network-error") {
        await page.route("**/rest/v1/**", async (route) => {
          if (route.request().url().includes("sessions")) {
            await route.fulfill({
              body: JSON.stringify({ message: "network fixture failure" }),
              contentType: "application/json",
              status: 500,
            });
            return;
          }
          await route.continue();
        });
        await page.reload();
        await expect(page.locator("body")).toBeVisible();
        await page.unrouteAll({ behavior: "ignoreErrors" });
        // Restore a healthy page for subsequent fixtures.
        await page.goto(fixture.path);
      }

      await settleForScreenshot(page);
      await expectSingleDocumentScroller(page);
      await expectNoUnintendedHorizontalOverflow(page);
      const isLabRoute = fixture.path.startsWith("/dev/") || fixture.path.startsWith("/fixtures/");
      if (!("setup" in fixture && fixture.setup === "validation-error")) {
        await expectNoSeriousAxeViolations(page, { disableColorContrast: isLabRoute });
      } else {
        await expectNoSeriousAxeViolations(page, { disableColorContrast: true });
      }

      if (fixture.name === "high-density") {
        await expect(page.locator(".session-list-row")).toHaveCount(50);
      }
      if (fixture.name === "running") {
        await expect(page.getByText(/Agent generating|Running/i).first()).toBeVisible();
      }
      if (fixture.name === "awaiting-review") {
        await expect(page.getByText(/Awaiting review/i).first()).toBeVisible();
      }
      if (fixture.name === "changes-requested") {
        await expect(page.getByText(/Changes requested|Rejected/i).first()).toBeVisible();
      }
      if (fixture.name === "archived" || fixture.name === "complete") {
        await expect(page.getByText(/Archived|Complete|Approved/i).first()).toBeVisible();
      }
      if (fixture.name === "failed") {
        await expect(page.locator("#main-content")).toBeVisible();
      }
    }
  });
});
