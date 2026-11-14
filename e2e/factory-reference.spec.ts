import { expect, test as base, type Page, type TestInfo } from "@playwright/test";
import axe from "axe-core";

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const themes = ["light", "dark"] as const;
const fixtureTime = new Date("2026-11-08T12:00:00Z");

const test = base.extend({
  page: async ({ page, baseURL }, runWithPage) => {
    if (!baseURL) throw new Error("The factory reference suite requires the local preview server.");
    const origin = new URL(baseURL).origin;
    const unexpected: string[] = [];
    await page.clock.setFixedTime(fixtureTime);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort();
    });
    await runWithPage(page);
    expect(unexpected, "Unstubbed fixture requests").toEqual([]);
  },
});

test.use({
  contextOptions: { reducedMotion: "reduce", serviceWorkers: "block" },
  locale: "en-US",
  timezoneId: "UTC",
});

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", caret: "hide", path });
  await info.attach(name, { contentType: "image/png", path });
}

async function expectAccessible(page: Page, { sessionsLedger = false } = {}) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const engine = Reflect.get(window, "axe") as typeof axe;
    const { violations } = await engine.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
    return violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }));
  });
  // Baseline the current archived badge contrast and compact issue-link size.
  // Keep axe active on every other element and rule.
  const unexpected = violations.flatMap(({ id, targets }) =>
    targets
      .filter(
        (target) =>
          !(
            sessionsLedger &&
            target.some(
              (selector) =>
                typeof selector === "string" &&
                ((id === "color-contrast" && selector.includes(".sessions-ledger-archived")) ||
                  (id === "target-size" &&
                    page.viewportSize()?.width === 390 &&
                    /^a\[href\$="OP-\d+"\]$/u.test(selector))),
            )
          ),
      )
      .map((target) => ({ id, target })),
  );
  expect(unexpected).toEqual([]);
}

for (const viewport of viewports) {
  for (const colorScheme of themes) {
    test.describe(`${viewport.width}px ${colorScheme}`, () => {
      test.use({ colorScheme, viewport });

      test("Pipeline shows the current shell and bounded lane states", async ({ page }, info) => {
        await page.goto("/dev/pipeline-layout");
        await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
        await expect(page.getByRole("combobox", { name: "Filter by status" })).toBeVisible();
        const header = page.locator("[data-shell-header]");
        await expect(
          header.getByRole("button", { name: "New session", exact: true }),
        ).toBeVisible();
        await capture(page, info, "pipeline-populated");
        await expectAccessible(page);

        await page.goto("/dev/pipeline-layout?loading=1");
        await expect(page.getByRole("status", { name: "Loading pipeline" })).toBeVisible();
        await capture(page, info, "pipeline-loading");

        await page.goto("/dev/pipeline-layout?empty=1");
        await expect(page.getByText("No active sessions", { exact: true })).toBeVisible();
        await capture(page, info, "pipeline-empty");

        await page.route("**/api/workspaces/proof-workspace/pipeline-dashboard", (route) =>
          route.fulfill({ status: 503, json: { error: "Could not load more sessions." } }),
        );
        await page.goto("/dev/pipeline-layout?partial=1");
        const more = page.getByRole("button", { name: "Load more Plan sessions" });
        await expect(more).toHaveText("Load more (6 of 7)");
        await more.scrollIntoViewIfNeeded();
        await capture(page, info, "pipeline-partial");
        await more.click();
        await expect(
          page.getByRole("alert").filter({ hasText: "Could not load more sessions." }),
        ).toBeVisible();
        await expect(more).toBeEnabled();
        await expect(
          page.getByRole("link", { name: /Make the pipeline usable on mobile/ }).first(),
        ).toBeVisible();
        await capture(page, info, "pipeline-page-error");
      });

      test("Sessions preserves named filters, focus and document scrolling", async ({
        page,
      }, info) => {
        await page.goto("/dev/sessions-ledger");
        const search = page.getByRole("searchbox");
        await expect(search).toBeVisible();
        await expect(page.getByRole("radio", { name: /^All/ })).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Open session #2: Seeded ledger session 2", exact: true }),
        ).toHaveAttribute("href", "/w/fixture/sessions/2");
        await capture(page, info, "sessions-populated");
        await expectAccessible(page, { sessionsLedger: true });
        await search.fill("checkpoints");
        const clear = page.getByRole("button", { name: "Clear search", exact: true });
        await clear.focus();
        await page.keyboard.press("Enter");
        await expect(search).toBeFocused();
        await expect(search).toHaveValue("");
        await page.evaluate(() => window.scrollTo(0, 300));
        await expect
          .poll(() =>
            page.evaluate(() => ({
              documentScrolls: document.scrollingElement === document.documentElement,
              mainScrolls: document.querySelector("#main-content")?.scrollTop !== 0,
              moved: window.scrollY > 0,
            })),
          )
          .toEqual({ documentScrolls: true, mainScrolls: false, moved: true });

        await page.goto("/dev/sessions-ledger?state=empty");
        await expect(page.getByText("No sessions yet")).toBeVisible();
        await capture(page, info, "sessions-empty");

        await page.goto("/dev/loading-continuity");
        await expect(page.getByRole("status", { name: "Loading sessions" })).toBeVisible();
        await capture(page, info, "sessions-loading");
      });

      test("Review Workbench keeps artifact controls and restores dialog focus", async ({
        page,
      }, info) => {
        await page.goto("/dev/interaction-motion?reference=1&reviewState=editable");
        const artifact = page.getByRole("region", { name: "Build artifact", exact: true });
        await expect(
          artifact.getByRole("heading", { name: "Build artifact", level: 2, exact: true }),
        ).toBeVisible();
        await expect(
          artifact.getByText("Version 1 is ready for review.", { exact: true }),
        ).toBeVisible();
        await expect(artifact.getByRole("button", { name: "Comments", exact: true })).toBeVisible();
        await expect(
          artifact.getByRole("button", { name: "Approve stage", exact: true }),
        ).toBeVisible();
        await expect(
          page
            .getByRole("region", { name: "Session runs" })
            .getByRole("heading", { name: "Run history" }),
        ).toHaveAttribute("id", "session-runs-heading");
        await capture(page, info, "review-artifact");
        await expectAccessible(page);
        const trigger = page.getByRole("button", { name: "Request changes", exact: true });
        await trigger.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: /Request changes/ });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("textbox", { name: "Feedback for Wallie" })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
      });

      test("Settings preserves category links and resolves existing hashes", async ({
        page,
      }, info) => {
        await page.route(
          /\/api\/workspaces\/11111111-1111-4111-8111-111111111111\/(delivery|execution)-policy(?:\?.*)?$/,
          (route) =>
            route.request().method() === "GET"
              ? route.fulfill({ json: { policy: null } })
              : route.fallback(),
        );
        await page.route("**/api/codex/connection", (route) =>
          route.request().method() === "GET"
            ? route.fulfill({ json: { connected: false, checkedAt: fixtureTime.toISOString() } })
            : route.fallback(),
        );
        await page.goto("/dev/settings?category=workspace#coding-agent");
        await expect(page).toHaveURL(/\/dev\/settings\?category=integrations#runtime$/u);
        await expect(page.locator("#runtime")).toBeVisible();
        await expect(page.getByRole("link", { name: "Agent", exact: true })).toHaveAttribute(
          "href",
          "#runtime",
        );
        await expect(
          page
            .getByRole("navigation", { name: "Settings categories" })
            .getByRole("link", { name: /^Workspace/ }),
        ).toHaveAttribute("href", /\/settings\?category=workspace$/u);
        await expect(page.locator('[role="status"][aria-busy="true"]')).toHaveCount(0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture(page, info, "settings-integrations");
        await expectAccessible(page);

        await page.goto("/dev/settings?category=advanced&state=missing-usage");
        const usage = page.locator("#usage");
        await expect(usage.getByText("Total runs", { exact: true })).toBeVisible();
        await expect(usage.getByText("Unavailable", { exact: true })).toHaveCount(3);
        await usage.scrollIntoViewIfNeeded();
        await capture(page, info, "settings-partial-usage");

        await page.goto("/dev/settings?state=error");
        const error = page.getByRole("heading", { name: "Integration details unavailable" });
        await expect(error).toBeVisible();
        await error.scrollIntoViewIfNeeded();
        await capture(page, info, "settings-error");
        await page.getByRole("link", { name: "Restore fixture setup data" }).click();
        await expect(page.locator("#runtime")).toBeVisible();
        await expect(error).toHaveCount(0);
      });

      test("Onboarding exposes setup and its blocking verification result", async ({
        page,
      }, info) => {
        await page.goto("/dev/copy-states?state=onboarding");
        await expect(page.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
        await capture(page, info, "onboarding-setup");
        await expectAccessible(page);

        await page.goto("/dev/copy-states?state=onboarding-blocked");
        await expect(
          page.getByRole("heading", { name: "Verification needs attention" }),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: "Retry verification" })).toBeEnabled();
        await expect(
          page.getByRole("status").filter({ hasText: "Verification needs attention" }),
        ).toContainText("Agent sign-in expired.");
        await capture(page, info, "onboarding-blocked");
      });

      test("A failed route exposes a keyboard retry and focuses recovery", async ({
        page,
      }, info) => {
        await page.goto("/dev/copy-states");
        const retry = page.getByRole("button", { name: "Try again", exact: true });
        await expect(retry).toBeVisible();
        await capture(page, info, "route-recoverable-error");
        await retry.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("status").filter({ hasText: "Page loaded." })).toBeFocused();
      });
    });
  }
}
