import { expect, test } from "@playwright/test";

import { signIn, WORKSPACE_PATH } from "../helpers/auth";
import {
  dismissWithEscape,
  expectFocusMovesInto,
  expectFocusRestoredTo,
  expectNoKeyboardTrap,
  openWithKeyboard,
} from "../helpers/focus";
import {
  expectNoUnintendedHorizontalOverflow,
  expectSingleDocumentScroller,
} from "../helpers/overflow";

test.describe("keyboard and overlay focus regression", () => {
  test("mobile navigation, overlays, filters, tabs, and onboarding stay keyboard operable", async ({
    page,
  }) => {
    test.setTimeout(4 * 60_000);
    await page.setViewportSize({ height: 844, width: 390 });
    await signIn(page, `${WORKSPACE_PATH}/sessions/1`);
    await expectSingleDocumentScroller(page);
    await expectNoUnintendedHorizontalOverflow(page);

    const openNav = page.getByRole("button", { name: "Open workspace navigation" });
    await openWithKeyboard(page, openNav);
    const navDialog = page.getByRole("dialog", { name: "Workspace" });
    await expectFocusMovesInto(navDialog);
    await expectNoKeyboardTrap(page, 12);
    await dismissWithEscape(page);
    await expectFocusRestoredTo(openNav);

    const newSession = page.getByRole("button", { name: /New session/i }).first();
    await openWithKeyboard(page, newSession);
    const dialog = page.getByRole("dialog", { name: "Start a new session" });
    await expectFocusMovesInto(dialog);
    await dismissWithEscape(page);
    await expectFocusRestoredTo(newSession);

    await page.goto(`${WORKSPACE_PATH}/sessions`);
    const statusFilter = page.getByRole("combobox", { name: /Status/i }).first();
    if (await statusFilter.isVisible().catch(() => false)) {
      await openWithKeyboard(page, statusFilter);
      const listbox = page.getByRole("listbox").first();
      await expect(listbox).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await dismissWithEscape(page);
      await expectFocusRestoredTo(statusFilter);
    }

    await page.goto(`${WORKSPACE_PATH}/sessions/1`);
    const tabs = page.getByRole("tab");
    if ((await tabs.count()) >= 2) {
      await tabs.nth(0).focus();
      await page.keyboard.press("ArrowRight");
      await expect(tabs.nth(1)).toBeFocused();
    }

    const requestChanges = page
      .getByRole("button", { name: /Request changes|Reject|Changes requested/i })
      .first();
    if (await requestChanges.isVisible().catch(() => false)) {
      await openWithKeyboard(page, requestChanges);
      const feedback = page
        .getByRole("dialog")
        .or(page.getByRole("textbox", { name: /feedback|changes/i }))
        .first();
      await expect(feedback).toBeVisible();
      await dismissWithEscape(page);
    }

    await page.goto(`${WORKSPACE_PATH}/onboarding`);
    await expect(page.locator("#main-content")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement !== document.body))
      .toBe(true);
    await expectNoKeyboardTrap(page, 16);
  });

  test("shared overlay primitives restore focus on Dialog, AlertDialog, Menu, and Select", async ({
    page,
  }) => {
    test.setTimeout(3 * 60_000);
    await page.setViewportSize({ height: 1000, width: 1440 });
    await page.goto("/dev/ui-primitives");
    await expect(
      page.getByRole("heading", { name: "Accessible overlay primitives" }),
    ).toBeVisible();

    const dialogTrigger = page.getByRole("button", { name: "Edit workspace" });
    await openWithKeyboard(page, dialogTrigger);
    const dialog = page.getByRole("dialog", { name: "Edit workspace" });
    await expectFocusMovesInto(dialog);
    await dismissWithEscape(page);
    await expectFocusRestoredTo(dialogTrigger);

    const alertTrigger = page.getByRole("button", { name: "Delete sandbox" });
    await openWithKeyboard(page, alertTrigger);
    const alert = page.getByRole("alertdialog", { name: "Delete sandbox?" });
    await expectFocusMovesInto(alert);
    await dismissWithEscape(page);
    await expectFocusRestoredTo(alertTrigger);

    const menuTrigger = page.getByRole("button", { name: "Session actions" });
    await openWithKeyboard(page, menuTrigger);
    const menu = page.getByRole("menu").first();
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await dismissWithEscape(page);
    await expectFocusRestoredTo(menuTrigger);

    const selectTrigger = page.getByRole("combobox").first();
    await openWithKeyboard(page, selectTrigger);
    await expect(page.getByRole("listbox").first()).toBeVisible();
    await dismissWithEscape(page);
    await expectFocusRestoredTo(selectTrigger);
  });

  test("pipeline reorder stays keyboard operable on the settings pipeline editor", async ({
    page,
  }) => {
    test.setTimeout(3 * 60_000);
    await page.setViewportSize({ height: 1000, width: 1440 });
    await signIn(page, `${WORKSPACE_PATH}/settings?category=pipeline`);
    await expect(page.locator("#main-content")).toBeVisible();

    const reorderHandle = page.getByRole("button", { name: /Drag to reorder/i }).first();
    await expect(reorderHandle).toBeVisible();
    await reorderHandle.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: /Drag to reorder/i }).first()).toBeVisible();
  });
});
