import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";
import { expectDropdownValue, selectDropdownOption } from "./helpers/select";

test.use({ actionTimeout: 10_000 });

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true, path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("an operator copies, edits, and publishes a scorer preset", async ({
  baseURL,
  page,
}, info) => {
  test.skip(process.env.WALLIE_FACTORY_SCORERS_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(90_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const scorers = `/w/${fixture.slug}/scorers?factory=${fixture.factoryId}`;
  const redundantPreset = "Redundant tests and scaffolding";
  const customRubric = "Check that each invoice regression test adds independent coverage.";

  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, scorers, { baseURL: fixture.app, email: fixture.ownerEmail });
    await page.getByRole("link", { name: "New scorer" }).click();
    const showPresets = page.getByText("Scorer presets", { exact: true });
    await showPresets.click();
    const presets = page.getByRole("list", { name: "Scorer presets" });
    for (const name of ["Correctness", "Verification", "Scope", redundantPreset]) {
      await expect(presets.getByRole("link", { name, exact: true })).toBeVisible();
    }
    await presets.getByRole("link", { name: redundantPreset, exact: true }).focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/preset=redundant-tests-v1#new-scorer$/);
    await expect(page.getByLabel("Scorer name", { exact: true })).toHaveValue(redundantPreset);
    await expect(page.getByRole("checkbox", { name: "Code diff", exact: true })).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Validation report", exact: true }),
    ).not.toBeChecked();
    const rubric = page.getByRole("textbox", { name: "Rubric", exact: true });
    const original = await rubric.inputValue();
    expect(original).toContain("meaningful regression coverage");
    await capture(page, info, "01-scorer-preset-desktop-light");

    await page.getByLabel("Scorer name", { exact: true }).fill("Unsaved draft");
    await rubric.fill("Unsaved rubric change.");
    const scale = page.getByRole("combobox", { name: "Score scale", exact: true });
    await selectDropdownOption(scale, "numeric");
    await page.getByRole("button", { name: "Restore preset", exact: true }).click();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(rubric).toHaveValue("Unsaved rubric change.");
    await showPresets.click();
    await presets.getByRole("link", { name: "Verification", exact: true }).click();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(rubric).toHaveValue("Unsaved rubric change.");
    await page.getByRole("button", { name: "Restore preset", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByLabel("Scorer name", { exact: true })).toHaveValue(redundantPreset);
    await expect(rubric).toHaveValue(original);
    await expectDropdownValue(scale, "boolean");

    await page.getByLabel("Scorer name", { exact: true }).fill("Invoice regression coverage");
    await rubric.fill(customRubric);
    await page.getByRole("button", { name: "Validate rubric", exact: true }).click();
    await expect(
      page.getByText("Rubric settings are valid. No runs were evaluated."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Publish scorer", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Invoice regression coverage" })).toBeVisible();
    await expect(page.getByRole("code").filter({ hasText: customRubric })).toBeVisible();

    await page.goto(scorers);
    await page.getByRole("link", { name: "New scorer" }).click();
    await showPresets.click();
    await presets.getByRole("link", { name: redundantPreset, exact: true }).click();
    await expect(rubric).toHaveValue(original);
    await page.getByText("Advanced", { exact: true }).click();
    await expect(page.getByLabel("Identifier", { exact: true })).toHaveValue("");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "02-scorer-preset-mobile-dark");

    await rubric.fill("Unpublished mobile edit.");
    await showPresets.click();
    await page.getByRole("link", { name: "Start with a blank draft" }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(rubric).toHaveValue("");
  } finally {
    await fixture.cleanup();
  }
});
