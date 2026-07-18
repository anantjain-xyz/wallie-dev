import { expect, test } from "@playwright/test";

const sessionCookieName = "sb-127-auth-token";

function encodeJwtPart(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("missing sessions preserve the protected-page login redirect", async ({ page }) => {
  await page.goto("/w/acme-corp/sessions");

  await expect(page).toHaveURL(/\/login\?next=%2Fw%2Facme-corp%2Fsessions$/);
  await expect(page.getByText("Dev password")).toBeVisible();
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
  await context.addCookies([
    {
      name: sessionCookieName,
      path: "/",
      url: baseURL,
      value: encodedSession,
    },
  ]);

  await page.goto("/w/acme-corp/sessions");

  await expect(page).toHaveURL(/\/login\?next=%2Fw%2Facme-corp%2Fsessions$/);
  await expect
    .poll(async () => (await context.cookies()).some(({ name }) => name === sessionCookieName))
    .toBe(false);
});
