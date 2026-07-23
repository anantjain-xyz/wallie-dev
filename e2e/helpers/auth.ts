import type { Page } from "@playwright/test";

const DEFAULT_SUPABASE_URL = "http://127.0.0.1:54321";
const DEFAULT_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81iuI";

function getSupabaseConfig() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SERVICE_ROLE_KEY ?? DEFAULT_SERVICE_ROLE_KEY;
  return { url, serviceKey };
}

function getPlaywrightBaseUrl() {
  const port = process.env.PLAYWRIGHT_PORT ?? "3100";
  const host = process.env.PLAYWRIGHT_HOST ?? "localhost";
  return process.env.PLAYWRIGHT_BASE_URL ?? `http://${host}:${port}`;
}

function getAllowlistedRedirectForGeneration(destination: string) {
  // Use a fixed origin that is always allowlisted in supabase/config.toml.
  // This avoids failures when PLAYWRIGHT_PORT/HOST is overridden to a non-allowlisted value.
  return `http://localhost:3000/auth/confirm?next=${encodeURIComponent(destination)}`;
}

export async function signInViaMagicLink(page: Page, destination = "/w/acme-corp/sessions") {
  const { url: supabaseUrl, serviceKey } = getSupabaseConfig();
  const playwrightBaseUrl = getPlaywrightBaseUrl();

  // Fixed allowlisted redirect for the admin generate_link call.
  const allowlistedRedirect = getAllowlistedRedirectForGeneration(destination);

  const response = await fetch(
    `${supabaseUrl}/auth/v1/admin/generate_link?redirect_to=${encodeURIComponent(allowlistedRedirect)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "magiclink",
        email: "anant@example.com",
        options: {
          redirectTo: allowlistedRedirect,
        },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`generate_link failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    action_link?: string;
    hashed_token?: string;
    properties?: {
      action_link?: string;
      hashed_token?: string;
      email_otp?: string;
    };
    email_otp?: string;
  };

  // Raw GoTrue returns top-level fields; JS SDK wraps them in properties.
  const hashedToken = data.hashed_token ?? data.properties?.hashed_token;
  const actionLink = data.action_link ?? data.properties?.action_link;

  if (!hashedToken && !actionLink) {
    throw new Error(`generate_link response missing tokens: ${JSON.stringify(data)}`);
  }

  // Prefer building the app's confirm URL from hashed_token, as the magic_link template does:
  // {{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email
  // This avoids relying on GoTrue's implicit-flow fragment handling, which our /auth/confirm route doesn't accept.
  if (hashedToken) {
    const confirmUrl =
      `${playwrightBaseUrl}/auth/confirm?next=${encodeURIComponent(destination)}` +
      `&token_hash=${encodeURIComponent(hashedToken)}&type=email`;
    await page.goto(confirmUrl);
    await page.waitForURL(/\/w\/acme-corp/, { timeout: 15_000 });
    return;
  }

  // Fallback: navigate to the raw action_link if hashed_token is absent (e.g., older GoTrue).
  if (actionLink) {
    await page.goto(actionLink);
    await page.waitForURL(/\/w\/acme-corp/, { timeout: 15_000 });
  }
}

export async function signIn(page: Page, destination = "/w/acme-corp/sessions") {
  return signInViaMagicLink(page, destination);
}
