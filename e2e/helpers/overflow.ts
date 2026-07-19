import { expect, type Page } from "@playwright/test";

export async function expectSingleDocumentScroller(page: Page) {
  const contract = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("#main-content");
    return {
      documentIsScroller: document.scrollingElement === document.documentElement,
      mainOverflowY: main ? getComputedStyle(main).overflowY : null,
      rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(contract.documentIsScroller).toBe(true);
  expect(contract.rootOverflowX).toBeLessThanOrEqual(1);
  if (page.url().includes("/w/")) {
    expect(contract.mainOverflowY).not.toMatch(/auto|scroll/u);
  }
}

export async function expectNoUnintendedHorizontalOverflow(page: Page) {
  const clipped = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const allowedHorizontalRegion = (element: Element) =>
      element.closest(
        '[aria-label="Pipeline board"], [aria-labelledby="pipeline-stage-label"], .artifact-table-scroll, .artifact-pre, [aria-label="Run input"]',
      );

    return [...document.body.querySelectorAll<HTMLElement>("*")]
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
  });

  expect(clipped).toEqual([]);
}
