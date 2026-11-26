import { expect, test } from "@playwright/test";

test("the shared skip link bypasses the landing header and reaches hosted sign-in", async ({
  page,
}) => {
  await page.goto("/");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  const main = page.getByRole("main");
  const hosted = main.getByRole("link", { name: "Get started" });

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/#main-content$/);
  await expect(main).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(hosted).toBeFocused();
  await expect(hosted).toHaveAccessibleDescription("Sign in by email, then set up your workspace.");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Wallie" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
});

test("the narrow landing shows a static workflow before the provider lists", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.clock.install();
  await page.goto("/");
  const workflow = page.getByRole("figure", { name: "Example workflow" });
  const agents = page.getByRole("list", { name: "Supported coding agents" });
  const sandboxes = page.getByRole("list", { name: "Supported sandboxes" });

  await expect(workflow).toBeInViewport({ ratio: 1 });
  await expect(workflow.getByText("Approve plan", { exact: true })).toBeVisible();
  await expect(workflow).toHaveAccessibleDescription(
    "Wallie starts the build after you approve the plan.",
  );
  const workflowBottom = await workflow.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  );
  for (const list of [agents, sandboxes]) {
    expect(await list.evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThan(
      workflowBottom,
    );
  }

  const illustrations = workflow.locator("..");
  const markup = await illustrations.evaluate((element) => element.innerHTML);
  await page.clock.fastForward(20_000);
  expect(await illustrations.evaluate((element) => element.innerHTML)).toBe(markup);

  for (const media of [
    { reducedMotion: "no-preference", forcedColors: "none" },
    { reducedMotion: "reduce", forcedColors: "none" },
    { reducedMotion: "no-preference", forcedColors: "active" },
  ] as const) {
    await page.emulateMedia(media);
    await expect(workflow.getByText("Build", { exact: true })).toBeVisible();
    expect(
      await illustrations.evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
  }
});
