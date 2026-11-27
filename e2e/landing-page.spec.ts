import { expect, test } from "@playwright/test";

test("the shared skip link bypasses the mast and the tour links reach hosted sign-in", async ({
  page,
}) => {
  await page.goto("/");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  const main = page.getByRole("main");
  const startTour = main.getByRole("link", { name: "Start the tour" });
  const hosted = main.getByRole("link", { name: "Try hosted Wallie" });

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/#main-content$/);
  await expect(main).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(startTour).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/#studio$/);
  await expect(page.locator("#studio")).toBeFocused();

  for (const [name, target] of [
    ["The line", "line"],
    ["Improvements", "improve"],
    ["Try Wallie", "start"],
  ]) {
    await page.getByRole("link", { name, exact: true }).press("Enter");
    await expect(page).toHaveURL(new RegExp(`/#${target}$`));
    await expect(page.locator(`#${target}`)).toBeFocused();
  }

  await page.keyboard.press("Tab");
  await expect(hosted).toBeFocused();
  await expect(hosted).toHaveAccessibleDescription(
    "For a hosted workspace, connect your GitHub repository, a sandbox, and your coding agent credentials. Linear is optional. You can also run Wallie yourself.",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Wallie" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send sign-in email" })).toBeVisible();
});

test("the narrow dark tour keeps the cutaway and the work order usable with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Self-improving software factory",
  );
  await expect(
    page.getByRole("img", { name: "Cutaway drawing of the Wallie software factory" }),
  ).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("main").locator("..")).toHaveCSS(
    "background-color",
    "rgb(25, 25, 25)",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  const line = page.getByRole("region", { name: "Add a dry-run mode to the deploy CLI." });
  const carrier = line.getByText("WO–024", { exact: true }).locator("..");
  const intake = line.getByRole("button", { name: "Intake", exact: true });
  const plan = line.getByRole("button", { name: "Plan", exact: true });
  const position = await carrier.evaluate((element) => getComputedStyle(element).transform);
  await page.clock.fastForward(20_000);
  await expect(carrier).toHaveCSS("transform", position);

  await intake.press("ArrowRight");
  await expect(plan).toBeFocused();
  await expect(plan).toHaveAttribute("aria-pressed", "true");
  await expect(line.getByRole("heading", { name: "A plan for the flag." })).toBeVisible();
  await expect(carrier).not.toHaveCSS("transform", position);
  await expect(carrier).toHaveCSS("transition-property", "none");
  expect(await carrier.evaluate((element) => element.getAnimations().length)).toBe(0);

  await page.emulateMedia({ forcedColors: "active" });
  await expect(plan).toBeVisible();
  await expect(plan).toBeFocused();
});

test("an explicit app theme overrides the system on the signed-out route", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    window.localStorage.setItem("wallie-theme", "light");
  });
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("main").locator("..")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  const ticket = page.getByRole("group", { name: "The sample work order" });
  await expect(ticket.getByText("Work order 024")).toHaveCSS("color", "rgb(79, 70, 229)");
});
