import { isAbsolute } from "node:path";

import { z } from "zod";

const configuration = z.object({
  WALLIE_BROWSER_FIXTURE_BROKER_URL: z.string().max(2048).url(),
  WALLIE_BROWSER_FIXTURE_BROKER_TOKEN: z
    .string()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9._~-]+$/),
  WALLIE_BROWSER_FIXTURE_ORIGIN: z.string().max(512).url(),
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
  };
}

const approvalScopeSchema = z
  .string()
  .max(128)
  .regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/[A-Za-z0-9._-]+$/);

export function readBrowserFixtureApprovalScope(value: string | undefined) {
  const parsed = approvalScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const encoderPathSchema = z.string().max(4096).refine(isAbsolute);
const browserVideoEncoderSchema = z.object({
  WALLIE_BROWSER_FFMPEG_PATH: encoderPathSchema,
  WALLIE_BROWSER_FFPROBE_PATH: encoderPathSchema,
});

export function readBrowserVideoEncoderPaths(env: Record<string, string | undefined>) {
  const parsed = browserVideoEncoderSchema.safeParse(env);
  if (!parsed.success) return null;
  return {
    ffmpeg: parsed.data.WALLIE_BROWSER_FFMPEG_PATH,
    ffprobe: parsed.data.WALLIE_BROWSER_FFPROBE_PATH,
  };
}
