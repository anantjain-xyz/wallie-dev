import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/auth";

declare global {
  interface Window {
    wallieEntrances: { id: string; loading: boolean }[];
    wallieNavTransitions: number;
  }
}

const releaseGates = new Set<() => void>();
test.afterEach(() => {
  for (const release of releaseGates) release();
  releaseGates.clear();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releaseGates.add(release);
  return { promise, release };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.wallieEntrances = [];
    window.wallieNavTransitions = 0;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof original>) {
      window.wallieEntrances.push({
        id: this.id,
        loading: Boolean(this.querySelector("[data-route-loading]")),
      });
      return original.apply(this, args);
    };
    document.addEventListener("transitionrun", (event) => {
      if (
        event.target instanceof Element &&
        event.target.classList.contains("ui-shell-nav-indicator") &&
        event.propertyName === "transform"
      )
        window.wallieNavTransitions++;
    });
  });
});

for (const mobile of [false, true]) {
  test(`navigation moves its indicator and reveals usable content (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "/w/acme-corp");
    const nav = page.locator('nav[aria-label="Workspace navigation"]:visible');
    if (mobile) {
      await nav.getByRole("button", { name: "Workspace navigation: Pipeline" }).click();
      await page
        .getByRole("menu", { name: "Workspace pages" })
        .getByRole("menuitem", { name: "Sessions", exact: true })
        .click();
    } else {
      await expect(nav).toHaveAttribute("data-indicator-animated", "true");
      await nav.getByRole("link", { name: "Sessions", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.wallieEntrances.filter((call) => call.id === "main-content").length,
        ),
      )
      .toBe(1);
    expect(await page.evaluate(() => window.wallieEntrances.some((call) => call.loading))).toBe(
      false,
    );
    if (mobile) {
      const trigger = nav.getByRole("button", { name: "Workspace navigation: Sessions" });
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
      const menu = page.getByRole("menu", { name: "Workspace pages" });
      await expect(menu.getByRole("menuitem", { name: "Sessions", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await menu.press("Escape");
    } else {
      await expect.poll(() => page.evaluate(() => window.wallieNavTransitions)).toBeGreaterThan(0);
      const active = nav.locator('[aria-current="page"]');
      await expect
        .poll(async () => {
          const pill = await nav.locator(".ui-shell-nav-indicator").boundingBox();
          const link = await active.boundingBox();
          return Math.abs((pill?.x ?? 0) - (link?.x ?? 100));
        })
        .toBeLessThan(1);
    }
    await mkdir(".wallie/screenshots", { recursive: true });
    await page.screenshot({
      path: `.wallie/screenshots/navigation-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    await page.goto("/dev/loading-continuity");
    await expect(page.getByRole("status", { name: "Loading sessions" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `.wallie/screenshots/loading-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
  });
}

test("mobile keyboard navigation reaches every destination and header action", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "/w/acme-corp");
  const header = page.locator("[data-shell-header]");

  for (const [current, destination, path] of [
    ["Pipeline", "Sessions", "/w/acme-corp/sessions"],
    ["Sessions", "Settings", "/w/acme-corp/settings"],
    ["Settings", "Pipeline", "/w/acme-corp"],
  ]) {
    const trigger = header.getByRole("button", { name: `Workspace navigation: ${current}` });
    await trigger.focus();
    await trigger.press("ArrowDown");
    const menu = page.getByRole("menu", { name: "Workspace pages" });
    await expect(menu.getByRole("menuitem", { name: "Pipeline", exact: true })).toBeFocused();
    if (destination === "Sessions") await page.keyboard.press("ArrowDown");
    if (destination === "Settings") await page.keyboard.press("End");
    const item = menu.getByRole("menuitem", { name: destination, exact: true });
    await expect(item).toBeFocused();
    await item.press("Enter");
    await expect(page).toHaveURL(path);
    await expect(menu).toBeHidden();

    const activeTrigger = header.getByRole("button", {
      name: `Workspace navigation: ${destination}`,
    });
    await activeTrigger.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: destination, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await menu.press("Escape");
    await expect(activeTrigger).toBeFocused();
  }

  await page.keyboard.press("Tab");
  const create = header.getByRole("button", { name: "New session", exact: true });
  await expect(create).toBeFocused();
  await create.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Start a new session" });
  await expect(dialog).toBeVisible();
  await dialog.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(create).toBeFocused();
  await page.keyboard.press("Tab");
  const theme = header.getByRole("button", { name: /Switch to (light|dark) mode/ });
  await expect(theme).toBeFocused();
  const initialTheme = await page.locator("html").getAttribute("data-theme");
  await theme.press("Space");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", initialTheme ?? "");
  await theme.press("Space");
  await expect(page.locator("html")).toHaveAttribute("data-theme", initialTheme ?? "");
  await page.keyboard.press("Tab");
  const account = header.getByRole("button", { name: /^Account:/ });
  await expect(account).toBeFocused();
  await account.press("Enter");
  const accountMenu = page.getByRole("menu", { name: "Account", exact: true });
  await expect(accountMenu.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
  await accountMenu.press("Escape");
  await expect(account).toBeFocused();

  const skip = page.getByRole("link", { name: "Skip to main content" });
  await skip.focus();
  await skip.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("filter changes combine immediately, retain results, and preserve an in-progress search edit", async ({
  page,
}) => {
  await signIn(page);
  const gate = deferred();
  const queries: URL[] = [];
  await page.route("**/w/acme-corp/sessions?*", async (route) => {
    if (route.request().headers().rsc === "1") {
      queries.push(new URL(route.request().url()));
      await gate.promise;
    }
    await route.continue();
  });
  const initialRows = await page
    .getByRole("table", { name: "Sessions", exact: true })
    .textContent();
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByRole("button", { name: "Archived", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("Updating…", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Sessions", exact: true })).toHaveText(initialRows!);
  await page.getByRole("combobox", { name: "Sort sessions" }).click();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole("option", { name: "Oldest updated" }).click();
  const search = page.getByRole("searchbox");
  await search.fill("SSO");
  await search.press("Enter");
  await expect
    .poll(() =>
      queries.some(
        (url) =>
          url.searchParams.get("q") === "SSO" &&
          url.searchParams.get("scope") === "archived" &&
          url.searchParams.get("sort") === "oldest",
      ),
    )
    .toBe(true);
  await search.fill("SSO draft still being edited");
  await page.screenshot({ path: ".wallie/screenshots/filter-updating.png", fullPage: true });
  gate.release();
  await expect(page).toHaveURL(/q=SSO/);
  await expect(page.getByText("Updating…", { exact: true })).toBeHidden();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("SSO draft still being edited");
  expect(await page.evaluate(() => window.wallieEntrances.length)).toBe(0);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL("/w/acme-corp/sessions");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await page.screenshot({ path: ".wallie/screenshots/filter-restored.png", fullPage: true });
});

test("both motion preferences suppress page movement", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page, "/w/acme-corp");
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.wallieEntrances.length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "reduce";
  });
  await page.getByRole("link", { name: "Pipeline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pipeline", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.wallieEntrances.length)).toBe(0);
});
