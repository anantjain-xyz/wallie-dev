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

    const nav = page.getByRole("navigation", { name: "Setup steps" });
    const sandboxEntry =
      width === 390
        ? nav.getByRole("combobox", { name: "Setup step" })
        : nav.getByRole("button", { name: "Sandbox" });
    async function openSandbox() {
      await sandboxEntry.focus();
      await sandboxEntry.press("Enter");
      if (width === 390) {
        await page.getByRole("option", { name: "Sandbox", exact: true }).click();
      }
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
    await expect(page.getByText("Setup step 5 of 7")).toBeVisible();
    await expect(page.getByRole("link", { name: "Test capabilities" })).toHaveCount(0);
    await page.getByRole("button", { name: "Replace connection" }).click();
    await page.getByLabel("Token", { exact: true }).fill("synthetic-vercel-token");
    await page.getByRole("button", { name: "Find teams" }).press("Enter");
    await expect(page.getByRole("combobox", { name: "Team" })).toHaveValue("team_123");
    const project = page.getByRole("combobox", { name: "Project" });
    await expect(project).toHaveValue("prj_123");
    await project.focus();
    await page.screenshot({ path: info.outputPath("named-targets.png") });
    await expect(page.getByRole("button", { name: "Save connection" })).toBeEnabled();
    await page.getByRole("button", { name: "Enter IDs manually" }).click();
    await expect(page.getByLabel("Project ID")).toHaveValue("prj_123");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Vercel Sandbox connected" })).toBeVisible();
  });
}
