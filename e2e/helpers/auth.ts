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

function getBaseUrl() {
  const port = process.env.PLAYWRIGHT_PORT ?? "3100";
  const host = process.env.PLAYWRIGHT_HOST ?? "localhost";
  return process.env.PLAYWRIGHT_BASE_URL ?? `http://${host}:${port}`;
}

export async function signInViaMagicLink(page: Page, destination = "/w/acme-corp/sessions") {
  const { url: supabaseUrl, serviceKey } = getSupabaseConfig();
  const baseUrl = getBaseUrl();
  const redirectTo = `${baseUrl}/auth/confirm?next=${encodeURIComponent(destination)}`;

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
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
        redirectTo,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`generate_link failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    properties?: {
      action_link?: string;
    };
  };

  const actionLink = data.properties?.action_link;

  if (!actionLink) {
    throw new Error(`generate_link response missing action_link: ${JSON.stringify(data)}`);
  }

  // Navigate to the Supabase verify link - it will redirect through /auth/confirm and set session cookies
  await page.goto(actionLink);
  // Wait for eventual redirect to destination (or at least to workspace)
  await page.waitForURL(/\/w\/acme-corp/, { timeout: 15_000 });
}

export async function signIn(page: Page, destination = "/w/acme-corp/sessions") {
  return signInViaMagicLink(page, destination);
}
