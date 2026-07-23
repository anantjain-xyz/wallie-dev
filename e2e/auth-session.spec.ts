import { expect, test } from "@playwright/test";

function sessionCookieNameFromEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const hostnamePrefix = new URL(supabaseUrl).hostname.split(".")[0];

  return `sb-${hostnamePrefix}-auth-token`;
}

function encodeJwtPart(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("missing sessions preserve the protected-page login redirect", async ({ page }) => {
  await page.goto("/w/acme-corp/sessions");

  // Unauthenticated workspace loaders redirect to the workspace base path as `next`.
  await expect(page).toHaveURL(/\/login\?next=%2Fw%2Facme-corp$/);
  await expect(page.getByText("Sign in to Wallie")).toBeVisible();
});

test("logout without a mutable user record clears the flow back to login", async ({ page }) => {
  const response = await page.request.post("/auth/signout", {
    form: { next: "/w/acme-corp/sessions" },
  });

  expect(response.ok()).toBe(true);
  expect(response.url()).toMatch(/\/login\?next=%2Fw%2Facme-corp%2Fsessions$/);
});

test("an expired JWT fails closed, clears its cookie, and redirects to login", async ({
  baseURL,
  context,
  page,
}) => {
  const sessionCookieName = sessionCookieNameFromEnv();
  const expiredToken = `${encodeJwtPart({ alg: "ES256", kid: "expired-key", typ: "JWT" })}.${encodeJwtPart(
    {
      exp: Math.floor(Date.now() / 1_000) - 60,
      sub: "expired-user",
    },
  )}.c2lnbmF0dXJl`;
  const encodedSession = `base64-${Buffer.from(
    JSON.stringify({
      access_token: expiredToken,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      refresh_token: "unused-refresh-token",
      token_type: "bearer",
    }),
  ).toString("base64url")}`;
  // Playwright requires either `url` or a `domain`/`path` pair — not `url` + `path`.
  await context.addCookies([
    {
      name: sessionCookieName,
      url: baseURL,
      value: encodedSession,
    },
  ]);

  await page.goto("/w/acme-corp/sessions");

  await expect(page).toHaveURL(/\/login\?next=%2Fw%2Facme-corp$/);
  await expect
    .poll(async () => (await context.cookies()).some(({ name }) => name === sessionCookieName))
    .toBe(false);
});
