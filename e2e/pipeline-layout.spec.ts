import { expect, test, type Page } from "@playwright/test";

async function accountMenuHeaderGap(page: Page) {
  await page.getByRole("button", { name: /^Account:/ }).click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu).toBeVisible();
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>("[data-shell-header]");
    const menuEl = document.querySelector<HTMLElement>('[role="menu"][aria-label="Account"]');
    if (!header || !menuEl) {
      throw new Error("account menu or shell header was not in the document");
    }
    return menuEl.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
  });
}

async function layoutGeometry(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".pipeline-board")!;
    const board = grid.parentElement!;
    const lanes = [...grid.querySelectorAll<HTMLElement>(":scope > section")].filter(
      (lane) => getComputedStyle(lane).display !== "none",
    );
    return {
      boardOverflow: getComputedStyle(board).overflowY,
      firstCardTop: lanes[0].querySelector("article")!.getBoundingClientRect().top,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      visibleLanes: lanes.length,
    };
  });
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 664 },
  { width: 844, height: 390 },
  { width: 932, height: 430 },
]) {
  test(`loading and loaded pipeline stay compact at ${viewport.width}×${viewport.height}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport,
      hasTouch: true,
      isMobile: true,
      baseURL: test.info().project.use.baseURL,
    });
    const page = await context.newPage();
    try {
      await page.goto("/dev/pipeline-layout?loading=1");
      await expect(page.getByRole("status", { name: "Loading pipeline" })).toBeVisible();
      const loading = await layoutGeometry(page);
      expect(loading.boardOverflow).toBe("visible");
      expect(loading.visibleLanes).toBe(1);
      expect(loading.horizontalOverflow).toBeLessThanOrEqual(1);

      await page.goto("/dev/pipeline-layout");
      await expect(page.getByRole("combobox", { name: "Filter by status" })).toBeVisible();
      await expect(page.getByRole("button", { name: "All statuses", exact: true })).toBeHidden();
      const loaded = await layoutGeometry(page);
      expect(loaded.boardOverflow).toBe("visible");
      expect(loaded.visibleLanes).toBe(1);
      expect(loaded.horizontalOverflow).toBeLessThanOrEqual(1);
      // Keep the first card title/status visible even with the two-row shell in landscape.
      expect(loaded.firstCardTop).toBeLessThan(viewport.height - 64);
      expect(Math.abs(loaded.firstCardTop - loading.firstCardTop)).toBeLessThan(12);

      await page.getByRole("tab", { name: /Build/ }).click();
      await expect(page.getByRole("tab", { name: /Build/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect((await layoutGeometry(page)).visibleLanes).toBe(1);
      await page.evaluate(() => window.scrollTo(0, 400));
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(100);
      expect(
        await page.getByRole("searchbox").evaluate((input) => input.getBoundingClientRect().bottom),
      ).toBeLessThan(0);
    } finally {
      await context.close();
    }
  });
}

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`roomy pipeline keeps desktop columns at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    for (const path of ["/dev/pipeline-layout?loading=1", "/dev/pipeline-layout"]) {
      await page.goto(path);
      const geometry = await layoutGeometry(page);
      expect(geometry.boardOverflow).toBe("auto");
      expect(geometry.visibleLanes).toBe(2);
      expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
    }
    await expect(page.getByRole("combobox", { name: "Filter by status" })).toBeHidden();
    await expect(page.getByRole("button", { name: "All statuses", exact: true })).toBeVisible();
  });
}

test("account menu sits below the header with a visible gap on a 390px phone", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    baseURL: test.info().project.use.baseURL,
  });
  const page = await context.newPage();
  try {
    await page.goto("/dev/pipeline-layout");
    expect(await accountMenuHeaderGap(page)).toBeGreaterThanOrEqual(6);
  } finally {
    await context.close();
  }
});

test("account menu sits below the header with a visible gap on a 1280px desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/dev/pipeline-layout");
  expect(await accountMenuHeaderGap(page)).toBeGreaterThanOrEqual(6);
});

test("mobile scroll targets clear both header rows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/pipeline-layout");
  const gap = await page.evaluate(() => {
    const target = document.querySelectorAll<HTMLElement>("article h3")[3];
    target.scrollIntoView({ block: "start", behavior: "instant" });
    const header = document.querySelector<HTMLElement>("[data-shell-header]")!;
    return target.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(-1);
});

for (const width of [320, 390, 768]) {
  test(`compact workspace navigation keeps every destination reachable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/dev/pipeline-layout");
    const header = page.locator("[data-shell-header]");
    const trigger = header.getByRole("button", { name: "Workspace navigation: Pipeline" });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    for (const control of [
      trigger,
      header.getByRole("button", { name: "New session", exact: true }),
      header.getByRole("button", { name: /Switch to (light|dark) mode/ }),
      header.getByRole("button", { name: /^Account:/ }),
    ]) {
      await expect(control).toBeInViewport({ ratio: 1 });
      await control.click({ trial: true });
    }

    await trigger.click();
    const menu = page.getByRole("menu", { name: "Workspace pages" });
    await expect(menu).toBeVisible();
    for (const [name, href] of [
      ["Pipeline", "/w/proof"],
      ["Sessions", "/w/proof/sessions"],
      ["Settings", "/w/proof/settings"],
    ]) {
      const destination = menu.getByRole("menuitem", { name, exact: true });
      await expect(destination).toHaveAttribute("href", href);
      await expect(destination).toBeInViewport({ ratio: 1 });
      expect(await destination.evaluate((item) => item.scrollWidth <= item.clientWidth)).toBe(true);
      await expect
        .poll(() => destination.evaluate((item) => item.getBoundingClientRect().height))
        .toBeGreaterThanOrEqual(44);
      await destination.click({ trial: true });
    }
    await expect(menu.getByRole("menuitem", { name: "Pipeline", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("compact navigation supports keyboard access and enlarged labels without clipping", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/dev/pipeline-layout?empty=1");
  await page.addStyleTag({
    content:
      'html { font-size: 200%; } [data-shell-header] button, [role="menuitem"] { font-size: 26px; }',
  });
  const trigger = page.getByRole("button", { name: "Workspace navigation: Pipeline" });
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await trigger.focus();
  await trigger.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Workspace pages" });
  const pipeline = menu.getByRole("menuitem", { name: "Pipeline", exact: true });
  const sessions = menu.getByRole("menuitem", { name: "Sessions", exact: true });
  const settings = menu.getByRole("menuitem", { name: "Settings", exact: true });
  await expect(pipeline).toBeFocused();
  await pipeline.press("ArrowDown");
  await expect(sessions).toBeFocused();
  await sessions.press("End");
  await expect(settings).toBeFocused();
  for (const destination of [pipeline, sessions, settings]) {
    await expect(destination).toBeInViewport({ ratio: 1 });
    expect(await destination.evaluate((item) => item.scrollWidth <= item.clientWidth)).toBe(true);
  }
  await settings.press("Home");
  await expect(pipeline).toBeFocused();
  await pipeline.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  const header = page.locator("[data-shell-header]");
  for (const control of [
    trigger,
    header.getByRole("button", { name: "New session", exact: true }),
    header.getByRole("button", { name: /Switch to (light|dark) mode/ }),
    header.getByRole("button", { name: /^Account:/ }),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
    await control.click({ trial: true });
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const header = document.querySelector<HTMLElement>("[data-shell-header]")!;
        return Math.abs(
          Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) -
            header.getBoundingClientRect().height,
        );
      }),
    )
    .toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("resizing an open compact menu to desktop restores focus to the active tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/pipeline-layout");
  const trigger = page.getByRole("button", { name: "Workspace navigation: Pipeline" });
  await trigger.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Workspace pages" });
  await expect(menu.getByRole("menuitem", { name: "Pipeline", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", {
      name: "Pipeline",
      exact: true,
    }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("short desktop pipelines fill the space below the desktop header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  for (const path of ["/dev/pipeline-layout?loading=1", "/dev/pipeline-layout"]) {
    await page.goto(path);
    const minHeight = await page
      .locator("main > div")
      .evaluate((element) => parseFloat(getComputedStyle(element).minHeight));
    expect(minHeight).toBe(432);
  }
});
