import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

const workspacePath = "/w/acme-corp";
const screenshotRoot = join(process.cwd(), "output/playwright/responsive-matrix");
const viewports = [320, 390, 768, 1024, 1440] as const;
const themes = ["light", "dark"] as const;
const publicRoutes = [
  { name: "landing", path: "/" },
  { name: "login", path: "/login" },
] as const;
const authenticatedRoutes = [
  { name: "pipeline", path: workspacePath },
  { name: "sessions", path: `${workspacePath}/sessions` },
  { name: "session-detail", path: `${workspacePath}/sessions/1` },
  { name: "onboarding", path: `${workspacePath}/onboarding` },
  { name: "settings-integrations", path: `${workspacePath}/settings?category=integrations` },
  { name: "settings-pipeline", path: `${workspacePath}/settings?category=pipeline` },
  { name: "settings-advanced", path: `${workspacePath}/settings?category=advanced` },
  { name: "settings-workspace", path: `${workspacePath}/settings?category=workspace` },
] as const;

type Theme = (typeof themes)[number];

async function signIn(page: Page) {
  await page.goto(`${workspacePath}/sessions`);
  await expect(page).toHaveURL(/\/login\?/u);
  await page.getByText("Development alternative").click();
  await page.getByPlaceholder("dev@localhost.com").fill("anant@example.com");
  await page.getByPlaceholder("Password (min 6)").fill("password123");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(new RegExp(workspacePath, "u"));
}

async function applyTheme(page: Page, theme: Theme) {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem("wallie-theme", nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function expectResponsiveContract(page: Page, width: number) {
  const contract = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const allowedHorizontalRegion = (element: Element) =>
      element.closest(
        '[aria-label="Pipeline board"], [aria-labelledby="pipeline-stage-label"], .artifact-table-scroll, .artifact-pre, [aria-label="Run input"]',
      );
    const clippedElements = [...document.body.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          element.getClientRects().length > 0 &&
          (rect.right > viewportWidth + 1 || rect.left < -1) &&
          !allowedHorizontalRegion(element)
        );
      })
      .slice(0, 10)
      .map((element) => ({
        label: element.getAttribute("aria-label"),
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 60),
      }));
    const undersizedNamedActions = [
      ...document.querySelectorAll<HTMLElement>("button[aria-label], a[aria-label]"),
    ]
      .filter((element) => {
        if (element.getClientRects().length === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width < 43.5 || rect.height < 43.5;
      })
      .map((element) => ({
        height: element.getBoundingClientRect().height,
        label: element.getAttribute("aria-label"),
        width: element.getBoundingClientRect().width,
      }));
    const main = document.querySelector<HTMLElement>("#main-content");

    return {
      clippedElements,
      documentIsScroller: document.scrollingElement === document.documentElement,
      mainOverflowY: main ? getComputedStyle(main).overflowY : null,
      rootOverflow: document.documentElement.scrollWidth - viewportWidth,
      undersizedNamedActions,
    };
  });

  expect(contract.documentIsScroller).toBe(true);
  expect(contract.rootOverflow).toBeLessThanOrEqual(1);
  expect(contract.clippedElements).toEqual([]);
  if (width <= 767) expect(contract.undersizedNamedActions).toEqual([]);
  if (page.url().includes("/w/")) expect(contract.mainOverflowY).not.toMatch(/auto|scroll/u);
}

async function expectNoAxeViolations(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const browserAxe = (
      window as unknown as {
        axe: {
          run: (root: Document) => Promise<{
            violations: Array<{ help: string; id: string; impact: string | null }>;
          }>;
        };
      }
    ).axe;
    const result = await browserAxe.run(document);
    return result.violations.map(({ help, id, impact }) => ({ help, id, impact }));
  });
  expect(violations).toEqual([]);
}

async function captureRouteMatrix(
  page: Page,
  routes: ReadonlyArray<{ name: string; path: string }>,
) {
  for (const width of viewports) {
    await page.setViewportSize({ height: width <= 390 ? 844 : 900, width });
    for (const theme of themes) {
      for (const route of routes) {
        await page.goto(route.path);
        await applyTheme(page, theme);
        await expect(page.locator("#main-content")).toBeVisible();
        await expectResponsiveContract(page, width);
        if ((width === 390 && theme === "light") || (width === 1440 && theme === "dark")) {
          await expectNoAxeViolations(page);
        }
        await page.screenshot({
          fullPage: true,
          path: join(screenshotRoot, `${route.name}-${width}-${theme}.png`),
        });
      }
    }
  }
}

test("production viewport and theme matrix stays responsive and warning-free", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await mkdir(screenshotRoot, { recursive: true });
  const warnings: string[] = [];
  const warningPattern = /hydration|did not match|overflow|unique.*key|accessib/iu;
  page.on("console", (message) => {
    if (message.type() === "error" || warningPattern.test(message.text())) {
      warnings.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => warnings.push(`pageerror: ${error.message}`));

  await captureRouteMatrix(page, publicRoutes);
  await signIn(page);
  await captureRouteMatrix(page, authenticatedRoutes);

  expect(warnings).toEqual([]);
});

test("keyboard, coarse-pointer, reduced-motion, and zoom-critical flows remain usable", async ({
  browser,
}) => {
  test.setTimeout(3 * 60_000);
  const context = await browser.newContext({
    hasTouch: true,
    reducedMotion: "reduce",
    viewport: { height: 844, width: 390 },
  });
  const page = await context.newPage();
  await signIn(page);

  for (const route of authenticatedRoutes) {
    await page.goto(route.path);
    await expect(page.locator("#main-content")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement !== document.body))
      .toBe(true);
    await expectResponsiveContract(page, 390);
  }

  await page.goto(`${workspacePath}/sessions/1`);
  await page.getByRole("button", { name: "New session" }).tap();
  await page.getByLabel("Prompt").fill("Keyboard visibility proof");
  const linearField = page.getByLabel("Linear issue URL");
  await linearField.fill("https://example.com/not-linear");
  await linearField.blur();
  await expect(page.locator("#session-linear-error")).toBeVisible();

  await page.setViewportSize({ height: 450, width: 640 });
  await page.goto(`${workspacePath}/settings?category=integrations`);
  await expectResponsiveContract(page, 640);
  await context.close();
});
