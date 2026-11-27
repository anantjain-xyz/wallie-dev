import { expect, test } from "@playwright/test";

for (const { width, height, colorScheme } of [
  { width: 1440, height: 900, colorScheme: "light" },
  { width: 390, height: 844, colorScheme: "dark" },
] as const) {
  test(`preserves a draft and hands off focus at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    let navigations = 0;
    await page.route("**/api/**", (route) => route.abort());
    await page.route("**/api/workspaces/workspace-1/onboarding", (route) => {
      navigations++;
      const body = route.request().postDataJSON();
      return route.fulfill({
        json: {
          kind: "onboarding-mutation",
          onboarding: { currentStep: body.step },
          updatedAt: new Date(0).toISOString(),
        },
      });
    });
    await page.route(
      "**/api/workspaces/workspace-1/sandbox-connections/vercel/targets",
      (route) => {
        const { teamId } = route.request().postDataJSON();
        return route.fulfill({
          json: teamId
            ? {
                projects: [
                  { id: "prj_123", name: "Northwind runner" },
                  { id: "prj_stage", name: "Staging runner" },
                ],
              }
            : { teams: [{ id: "team_123", name: "Northwind", slug: "northwind" }] },
        });
      },
    );

    await page.goto("/dev/copy-states?state=onboarding");
    const pipeline = page.getByRole("textbox", { name: "Pipeline name" });
    await pipeline.fill("Uncommitted pipeline draft");
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();

    const disclosure = page.locator("summary").filter({ hasText: "All setup steps" });
    if (width === 390) {
      await expect(page.getByRole("navigation", { name: "Setup steps" })).toHaveCount(0);
      await disclosure.press("Enter");
    }
    const nav = page.getByRole("navigation", { name: "Setup steps" });
    await expect(nav).toHaveCount(1);
    const sandboxEntry = nav.getByRole("button", { name: "Sandbox" });
    async function openSandbox() {
      await sandboxEntry.focus();
      await sandboxEntry.press("Enter");
    }

    await openSandbox();
    const dialog = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
    const keep = dialog.getByRole("button", { name: "Keep editing" });
    await expect(keep).toBeFocused();
    await page.screenshot({ path: info.outputPath("keep-draft.png") });
    await keep.press("Enter");
    await expect(sandboxEntry).toBeFocused();
    await expect(pipeline).toHaveValue("Uncommitted pipeline draft");
    expect(navigations).toBe(0);

    await openSandbox();
    await dialog.getByRole("button", { name: "Discard changes" }).click();
    const heading = page.getByRole("heading", { name: "Connect Sandbox" });
    await expect(heading).toBeFocused();
    await expect(page.getByText("Execution access · Step 5 of 7")).toBeVisible();
    if (width === 390) await expect(nav).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Test capabilities" })).toHaveCount(0);
    await page.getByRole("button", { name: "Replace connection" }).click();
    await page.getByLabel("Token", { exact: true }).fill("synthetic-vercel-token");
    await page.getByRole("button", { name: "Find teams" }).press("Enter");
    await expect(page.getByRole("combobox", { name: "Team" })).toHaveAttribute(
      "data-value",
      "team_123",
    );
    const project = page.getByRole("combobox", { name: "Project" });
    await expect(project).toHaveAttribute("data-value", "prj_123");
    await expect(project).toHaveText("Northwind runner · northwind");
    await project.press("Enter");
    const projects = page.getByRole("listbox", { name: "Project" });
    await expect(
      projects.getByRole("option", { name: "Northwind runner · northwind" }),
    ).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: info.outputPath("named-targets.png") });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(project).toBeFocused();
    await expect(projects).not.toBeVisible();
    await expect(project).toHaveAttribute("data-value", "prj_123");
    await expect(page.getByRole("button", { name: "Save connection" })).toBeEnabled();
    await page.getByRole("button", { name: "Enter IDs manually" }).click();
    await expect(page.getByLabel("Project ID")).toHaveValue("prj_123");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Vercel Sandbox connected" })).toBeVisible();
  });
}

for (const width of [390, 320]) {
  test(`keeps current verification and its recovery ahead of diagnostics at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/**", (route) => route.abort());

    await page.goto("/dev/onboarding?state=stale");
    const status = page.locator("#onboarding-verification").getByRole("status");
    await expect(status).toContainText("Setup has changed");
    await expect(page.getByText(/Setup was completed previously/)).toBeVisible();
    const verify = page.getByRole("button", { name: "Verify again" });
    await expect(verify).toBeInViewport();
    await expect(page.getByRole("button", { name: "Create your first task" })).toHaveCount(0);
    const details = page.locator("summary").filter({ hasText: "All checks" });
    const previous = page.getByRole("heading", { name: "Previous verification result" });
    await expect(previous).toHaveCount(0);
    await details.press("Enter");
    await expect(previous).toBeVisible();
    await expect(page.getByText("gpt-previous-model", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

    await page.goto("/dev/onboarding?state=ready");
    await expect(status).toContainText("Setup is ready");
    await expect(page.getByRole("link", { name: "Back to sessions" })).toHaveAttribute(
      "href",
      "/w/northwind/sessions",
    );
    await expect(page.getByRole("button", { name: "Verify again" })).toHaveCount(0);

    await page.goto("/dev/onboarding?state=member");
    await expect(status).toContainText("Codex credential");
    await expect(status).toContainText("Ask a workspace owner or admin");
    await expect(page.getByRole("link", { name: "Back to sessions" })).toBeInViewport();
    await expect(page.getByRole("button", { name: /Fix agent access|Verify again/ })).toHaveCount(
      0,
    );
  });
}
