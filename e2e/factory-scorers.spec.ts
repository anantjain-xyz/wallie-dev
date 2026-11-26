import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";
import { selectDropdownOption } from "./helpers/select";

test.use({ actionTimeout: 10_000 });

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true, path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("an operator authors, binds, and revisits exact scorer revisions", async ({
  baseURL,
  page,
}, info) => {
  test.skip(process.env.WALLIE_FACTORY_SCORERS_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const base = `/w/${fixture.slug}`;
  const scorers = `${base}/scorers?factory=${fixture.factoryId}`;
  const createApi = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/scorers`;
  const firstRubric = "Pass when the retained report verifies the invoice reconciliation totals.";
  const secondRubric = "Pass when the report verifies totals and duplicate invoice handling.";
  const pendingRubric = "Pass when the report verifies totals, duplicate invoices, and rounding.";

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, `${base}/sessions?factory=${fixture.factoryId}`, {
      baseURL: fixture.app,
      email: fixture.ownerEmail,
    });
    const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
    const entry = navigation.getByRole("link", { name: "Scorers", exact: true });
    await expect(entry).toHaveAttribute("href", scorers);
    await entry.click();
    await expect(page.getByRole("heading", { name: "Scorers", exact: true })).toBeVisible();
    const create = page.getByRole("link", { name: "New scorer", exact: true });
    await create.focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("Scorer name", { exact: true }).fill("Invoice verification");
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByLabel("Identifier", { exact: true }).fill("invoice-verification");
    await page.getByLabel("Rubric", { exact: true }).fill(firstRubric);
    await page.getByRole("checkbox", { name: "Validation report", exact: true }).check();
    await selectDropdownOption(
      page.getByRole("combobox", { name: "Score scale", exact: true }),
      "numeric",
    );
    await page.getByLabel("Minimum score", { exact: true }).fill("0");
    await page.getByLabel("Maximum score", { exact: true }).fill("100");
    await page.getByLabel("Pass threshold", { exact: true }).fill("80");
    await page.getByLabel("Fail threshold", { exact: true }).fill("60");
    await page.getByRole("button", { name: "Validate rubric", exact: true }).click();
    await capture(page, info, "01-scorer-authoring-light");

    let releaseCreate = () => {};
    const holdCreate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    await page.route(`**${createApi}`, async (route) => {
      if (route.request().method() === "POST") await holdCreate;
      await route.continue();
    });
    const created = page.waitForResponse(
      (response) => response.url().endsWith(createApi) && response.request().method() === "POST",
    );
    try {
      await page.getByRole("button", { name: "Publish scorer", exact: true }).click();
      await expect(page.getByRole("button", { name: /Publishing/ })).toBeDisabled();
      await capture(page, info, "02-scorer-publishing");
    } finally {
      releaseCreate();
    }
    expect((await created).status()).toBe(201);
    await expect(
      page.getByRole("heading", { name: "Invoice verification", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Revision 1 published. The active factory binding is unchanged." }),
    ).toBeVisible();
    const detail = page.url();
    const concurrent = await page.context().newPage();
    try {
      await concurrent.goto(detail);
      const editableRubric = concurrent.getByRole("textbox", { name: "Rubric", exact: true });
      await editableRubric.fill(pendingRubric);
      await page.getByRole("textbox", { name: "Rubric", exact: true }).fill(secondRubric);
      await page.getByRole("button", { name: "Publish revision", exact: true }).click();
      await expect(page.getByRole("link", { name: /Revision 2/ })).toBeVisible();

      await concurrent.getByRole("button", { name: "Publish revision", exact: true }).click();
      await expect(concurrent.getByRole("link", { name: "Reload latest revision" })).toBeVisible();
      await expect(editableRubric).toHaveValue(pendingRubric);
      await capture(concurrent, info, "03-scorer-revision-conflict");
      await concurrent.getByRole("link", { name: "Reload latest revision" }).click();
      await concurrent.getByRole("button", { name: "Keep editing" }).click();
      await expect(editableRubric).toHaveValue(pendingRubric);
      await concurrent.getByRole("link", { name: "Reload latest revision" }).click();
      await concurrent.getByRole("button", { name: "Discard changes" }).click();
      await expect(editableRubric).toHaveValue(secondRubric);
      await expect(
        concurrent.getByRole("heading", { name: "Revision 2", exact: true }),
      ).toBeVisible();
    } finally {
      await concurrent.close();
    }

    await page.getByRole("link", { name: /Revision 1/ }).click();
    await expect(page.getByText(firstRubric, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish revision", exact: true })).toHaveCount(
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "04-scorer-historical-mobile-dark");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .getByRole("link", { name: "Bind revision 1 in Factory Definition", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Remove Invoice verification · Revision 1" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Validate and preview", exact: true }).click();
    const bindings = page.locator("#scorer-bindings");
    await expect(bindings).toContainText("Validated edit");
    await expect(bindings).toContainText("Invoice verification · Revision 1");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(bindings).toContainText("Saved draft");
    await expect(
      bindings.getByRole("link", { name: "Invoice verification · Revision 1" }),
    ).toBeVisible();
    await capture(page, info, "05-factory-scorer-binding-dark");
  } finally {
    await fixture.cleanup();
  }
});

test("search finds scorer names and identifiers beyond the first library page", async ({
  baseURL,
  page,
}) => {
  test.skip(process.env.WALLIE_FACTORY_SCORERS_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const library = `/w/${fixture.slug}/scorers?factory=${fixture.factoryId}`;
  const api = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/scorers`;
  const definition = {
    schemaVersion: 1,
    rubric: "Check that the retained report documents the expected behavior.",
    requiredEvidence: ["validation_report"],
    scoring: { kind: "boolean", passValue: true },
  };
  try {
    await signInViaMagicLink(page, library, { baseURL: fixture.app, email: fixture.ownerEmail });
    const names = Array.from(
      { length: 31 },
      (_, i) => `Library scorer ${String(i + 1).padStart(2, "0")}`,
    );
    for (let offset = 0; offset < names.length; offset += 5) {
      const batch = await Promise.all(
        names.slice(offset, offset + 5).map((name) =>
          page.request.post(api, {
            data: {
              name,
              definition,
              ...(name.endsWith("31") ? { slug: "verification-final" } : {}),
            },
          }),
        ),
      );
      expect(batch.every((response) => response.status() === 201)).toBe(true);
    }
    await page.goto(library);
    await expect(page.getByRole("link", { name: names[30]!, exact: true })).toHaveCount(0);
    const query = page.getByRole("searchbox", { name: "Search this factory’s scorers" });
    await query.fill("library scorer");
    await query.press("Enter");
    await page.getByRole("link", { name: "More scorers" }).click();
    await expect(query).toHaveValue("library scorer");
    const lastScorer = page.getByRole("link", { name: names[30]!, exact: true });
    await expect(lastScorer).toBeVisible();
    await expect(lastScorer.locator("..")).toContainText("Validation report · Boolean");
    await query.fill("verification-final");
    await query.press("Enter");
    await expect(lastScorer).toBeVisible();
    await query.fill("not in this factory");
    await query.press("Enter");
    await expect(
      page.getByText("No scorers match this search in the selected factory."),
    ).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});
