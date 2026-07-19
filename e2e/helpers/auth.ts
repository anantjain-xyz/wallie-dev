import { expect, type Page } from "@playwright/test";

export const WORKSPACE_PATH = "/w/acme-corp";

export async function signIn(page: Page, destination = `${WORKSPACE_PATH}/sessions`) {
  await page.goto(destination);
  if (!page.url().includes("/login")) {
    await expect(page).toHaveURL(new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return;
  }

  await expect(page).toHaveURL(/\/login\?/u);
  const passwordAuth = page.locator("details").filter({ hasText: "Development alternative" });
  await passwordAuth.locator("summary").click();
  await expect(passwordAuth).toHaveAttribute("open", "");
  await passwordAuth.getByPlaceholder("dev@localhost.com").fill("anant@example.com");
  await passwordAuth.locator('input[name="password"]').fill("password123");
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 }),
    passwordAuth
      .getByRole("button", { name: /Continue with password|Try password again/i })
      .click(),
  ]);
  await expect(page).toHaveURL(new RegExp(WORKSPACE_PATH, "u"));

  const current = new URL(page.url());
  const target = new URL(destination, page.url());
  if (current.pathname + current.search !== target.pathname + target.search) {
    await page.goto(destination);
  }
  await expect(page).toHaveURL(
    new RegExp(`${target.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
}
