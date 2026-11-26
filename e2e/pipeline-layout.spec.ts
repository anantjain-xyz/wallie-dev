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
      const status = page.getByRole("combobox", { name: "Filter by status", exact: true });
      await expect(status).toBeVisible();
      await expect(status).toHaveText("All statuses");
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

for (const width of [320, 390]) {
  test(`compact Pipeline keeps keyboard focus visible across factory stages at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/dev/pipeline-layout?aggregate=1");
    const strip = page.getByRole("tablist", { name: "Pipeline stage" });
    const tabs = strip.getByRole("tab");
    await expect(tabs).toHaveCount(4);
    await expect(tabs.first()).toHaveAccessibleName(
      /Product engineering.*Plan the first production release/,
    );
    await expect(tabs.last()).toHaveAccessibleName(
      /Customer tools.*Record the decision and publish/,
    );
    expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.getByRole("combobox", { name: "Filter by status" }).focus();
    await page.keyboard.press("Tab");
    await expect(tabs.first()).toBeFocused();
    const startY = await page.evaluate(() => scrollY);

    for (const [key, position] of [
      ["End", 3],
      ["ArrowLeft", 2],
      ["Home", 0],
      ["ArrowRight", 1],
    ] as const) {
      await page.keyboard.press(key);
      const tab = tabs.nth(position);
      await expect(tab).toBeFocused();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const geometry = await tab.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const viewport = element.parentElement!.getBoundingClientRect();
        return {
          left: bounds.left - viewport.left,
          right: viewport.right - bounds.right,
          y: scrollY,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.right).toBeGreaterThanOrEqual(-1);
      expect(geometry.y).toBe(startY);
      expect((await layoutGeometry(page)).visibleLanes).toBe(1);
      expect((await layoutGeometry(page)).horizontalOverflow).toBeLessThanOrEqual(1);
      if (width === 390 && key === "End") {
        await page.screenshot({ path: info.outputPath("pipeline-compact-focus.png") });
      }
    }
  });
}

test("aggregate Pipeline labels factory ownership without changing card hierarchy", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dev/pipeline-layout?aggregate=1");
  const lane = page.getByRole("tabpanel", { name: "Review the generated release evidence" });
  await expect(lane.getByText("Customer tools", { exact: true })).toBeVisible();
  const card = lane.getByRole("article").first();
  await expect(card.getByRole("heading", { level: 3 })).toBeVisible();
  await expect(card.getByRole("link", { name: /^Review session / })).toBeVisible();
  await page.screenshot({ path: info.outputPath("pipeline-aggregate-desktop.png") });
});

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
    const status = page.getByRole("combobox", { name: "Filter by status", exact: true });
    await expect(status).toBeVisible();
    await status.click();
    await expect(page.getByRole("option", { name: "All statuses", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
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
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    await expect(drawer).toBeVisible();
    for (const [name, href] of [
      ["Pipeline", "/w/proof"],
      ["Sessions", "/w/proof/sessions"],
      ["Runs", "/w/proof/runs"],
      ["Settings", "/w/proof/settings"],
    ]) {
      const destination = drawer.getByRole("link", { name, exact: true });
      await expect(destination).toHaveAttribute("href", href);
      await expect(destination).toBeInViewport({ ratio: 1 });
      expect(await destination.evaluate((item) => item.scrollWidth <= item.clientWidth)).toBe(true);
      await expect
        .poll(() => destination.evaluate((item) => item.getBoundingClientRect().height))
        .toBeGreaterThanOrEqual(44);
      await destination.click({ trial: true });
    }
    await expect(drawer.getByRole("link", { name: "Pipeline", exact: true })).toHaveAttribute(
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
      'html { font-size: 200%; } [data-shell-header] button, [role="dialog"] a { font-size: 26px; }',
  });
  const trigger = page.getByRole("button", { name: "Workspace navigation: Pipeline" });
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await trigger.focus();
  await trigger.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Workspace pages" });
  const close = drawer.getByRole("button", { name: "Close navigation", exact: true });
  const links = drawer.getByRole("link");
  await expect
    .poll(() => drawer.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);
  await close.focus();
  for (const destination of await links.all()) {
    await page.keyboard.press("Tab");
    await expect(destination).toBeFocused();
    await expect(destination).toBeInViewport();
    expect(await destination.evaluate((item) => item.scrollWidth <= item.clientWidth)).toBe(true);
  }
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
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

test("resizing an open navigation drawer restores focus to the active desktop link", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/pipeline-layout");
  const trigger = page.getByRole("button", { name: "Workspace navigation: Pipeline" });
  await trigger.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Workspace pages" });
  await expect
    .poll(() => drawer.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(drawer).toBeHidden();
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
      .getByRole("main")
      .locator(":scope > .contents > div:has(.pipeline-board)")
      .evaluate((element) => parseFloat(getComputedStyle(element).minHeight));
    expect(minHeight).toBe(432);
  }
});
