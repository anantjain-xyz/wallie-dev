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

test("home redirect back to workspace creation finishes navigation", async ({ page }) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  test.skip(!supabaseUrl || !serviceKey, "Requires the isolated auth test stack");
  const headers = {
    apikey: serviceKey!,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "magiclink",
      email: `route-recovery-${crypto.randomUUID()}@example.com`,
    }),
  });
  expect(response.ok).toBe(true);
  const auth = (await response.json()) as { hashed_token: string; id: string };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto(
      `/auth/confirm?next=${encodeURIComponent("/onboarding/workspace")}&token_hash=${encodeURIComponent(auth.hashed_token)}&type=email`,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create workspace");
    await page.evaluate(() => {
      document.documentElement.dataset.redirectProof = "same-document";
    });
    await page.route(
      (url) => url.pathname === "/",
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await page
      .getByRole("link", { name: "Wallie home" })
      .evaluate((element: HTMLAnchorElement) => element.click());
    await expect(page.locator("[data-route-progress]")).toBeVisible();
    release();
    await expect(page.locator("[data-route-progress]")).toHaveCount(0);
    await expect(page).toHaveURL(/\/onboarding\/workspace$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create workspace");
    await expect(page.locator("html")).toHaveAttribute("data-redirect-proof", "same-document");
    await expect(page.getByText("This page is taking longer than usual.")).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    if (auth.id) {
      const removed = await fetch(`${supabaseUrl}/auth/v1/admin/users/${auth.id}`, {
        method: "DELETE",
        headers,
      });
      expect(removed.ok).toBe(true);
    }
  }
});

test("an active run does not keep navigation feedback visible", async ({ page }, testInfo) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sessions");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/w/acme-corp/sessions/8",
    async (route) => {
      await held;
      await route.continue();
    },
  );
  try {
    await page
      .locator('a[href="/w/acme-corp/sessions/8"]')
      .first()
      .evaluate((element: HTMLAnchorElement) => element.click());
    await expect(page.locator("[data-route-progress]")).toBeVisible();
    release();
    await expect(
      page.locator('[data-run-id] [role="status"][aria-busy="true"]').first(),
    ).toBeVisible();
    await expect(page.locator("[data-route-progress]")).toHaveCount(0);
    await expect(page.getByText("This page is taking longer than usual.")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("active-run-navigation.png"),
      fullPage: true,
    });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
