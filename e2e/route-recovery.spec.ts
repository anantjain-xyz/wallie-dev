import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("unavailable pages give a useful return destination", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This page isn’t available");
  await expect(page.getByRole("link", { name: "Back to Wallie" })).toHaveAttribute("href", "/");
  await signIn(page);
  await page.goto("/w/acme-corp/sessions/999999");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This page isn’t available");
  await expect(page.getByRole("link", { name: "Back to sessions" })).toHaveAttribute(
    "href",
    "/w/acme-corp/sessions",
  );
});

test("slow navigation keeps feedback until the destination is usable", async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto("/w/acme-corp");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pipeline");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/w/acme-corp/sessions",
    async (route) => {
      await held;
      await route.continue();
    },
  );
  try {
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("link", { name: "Sessions", exact: true })
      .evaluate((element: HTMLAnchorElement) => element.click());
    await expect(page.locator("[data-route-progress]")).toBeVisible();
    await expect(page.getByText("This page is taking longer than usual.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-route-progress]")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("slow-navigation.png") });
    release();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sessions");
    await expect(page.locator("[data-route-progress]")).toHaveCount(0);
    await expect(page.getByText("This page is taking longer than usual.")).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
