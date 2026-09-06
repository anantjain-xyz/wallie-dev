import { expect, test, type Page } from "@playwright/test";

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
      expect(loaded.firstCardTop).toBeLessThan(viewport.height - 100);
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
