import { z } from "zod";

const configuration = z.object({
  WALLIE_BROWSER_FIXTURE_BROKER_URL: z.string().max(2048).url(),
  WALLIE_BROWSER_FIXTURE_BROKER_TOKEN: z
    .string()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9._~-]+$/),
  WALLIE_BROWSER_FIXTURE_ORIGIN: z.string().max(512).url(),
  WALLIE_BROWSER_FIXTURE_APPROVAL_SCOPE: z
    .string()
    .max(128)
    .regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/[A-Za-z0-9._-]+$/),
});

function privateFixtureUrl(url: URL): boolean {
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))
  );
}

export function readBrowserFixtureEnvironment(env: Record<string, string | undefined>) {
  const result = configuration.safeParse(env);
  if (!result.success) return null;
  const data = result.data;
  const brokerUrl = new URL(data.WALLIE_BROWSER_FIXTURE_BROKER_URL);
  const preview = new URL(data.WALLIE_BROWSER_FIXTURE_ORIGIN);
  if (
    !privateFixtureUrl(brokerUrl) ||
    brokerUrl.search ||
    !privateFixtureUrl(preview) ||
    preview.search ||
    preview.pathname !== "/"
  ) {
    return null;
  }

  return {
    brokerUrl,
    brokerToken: data.WALLIE_BROWSER_FIXTURE_BROKER_TOKEN,
    previewOrigin: preview.origin,
    approvalScopeId: data.WALLIE_BROWSER_FIXTURE_APPROVAL_SCOPE,
  };
}
