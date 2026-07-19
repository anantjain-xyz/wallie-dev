import { expect, type Locator, type Page } from "@playwright/test";

export async function expectFocusMovesInto(overlay: Locator) {
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () =>
      overlay.evaluate(
        (element) => element.contains(document.activeElement) || element === document.activeElement,
      ),
    )
    .toBe(true);
}

export async function expectFocusRestoredTo(trigger: Locator) {
  await expect
    .poll(async () =>
      trigger.evaluate((element) => {
        const active = document.activeElement;
        return active === element || element.contains(active);
      }),
    )
    .toBe(true);
}

export async function openWithKeyboard(page: Page, trigger: Locator) {
  await trigger.focus();
  await expect
    .poll(async () =>
      trigger.evaluate(
        (element) => document.activeElement === element || element.contains(document.activeElement),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Enter");
}

export async function dismissWithEscape(page: Page) {
  await page.keyboard.press("Escape");
}

export async function expectNoKeyboardTrap(page: Page, cycles = 24) {
  const seen = new Set<string>();
  for (let index = 0; index < cycles; index += 1) {
    await page.keyboard.press("Tab");
    const fingerprint = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return "none";
      return [
        active.tagName,
        active.id,
        active.getAttribute("aria-label") ?? "",
        active.className?.toString?.().slice(0, 40) ?? "",
      ].join("|");
    });
    seen.add(fingerprint);
  }
  expect(seen.size).toBeGreaterThan(1);
}
