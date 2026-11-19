import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { readBrowserFixtureEnvironment } from "@/env/browser-fixture";

import {
  BROWSER_CAPTURE_POLICY,
  browserRunIdentitySchema,
  type BrowserRunIdentity,
  type BrowserVerificationPlan,
} from "./browser-contract";

export type BrowserFixtureConfiguration = NonNullable<
  ReturnType<typeof readBrowserFixtureEnvironment>
>;

const brokerResponseSchema = z.strictObject({
  nonce: z.string().uuid(),
  identity: browserRunIdentitySchema,
  path: z.string().max(256),
  regionTestId: z.string().max(100),
  policy: z.literal(BROWSER_CAPTURE_POLICY),
  previewUrl: z.string().max(2048).url(),
  expiresAt: z.string().datetime({ offset: true }),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const maxTargetLifetimeMs = 90_000;
const maxBrokerBytes = 8 * 1024;
const maxFixtureBytes = 512 * 1024;

async function boundedBody(
  response: Response,
  maximum: number,
  mediaType: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error("Fixture response is empty.");
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== mediaType ||
    Number(response.headers.get("content-length")) > maximum ||
    signal.aborted
  ) {
    void body.cancel().catch(() => {});
    throw new Error("Fixture response is unavailable.");
  }

  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const buffer = new Uint8Array(maximum);
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return buffer.subarray(0, size);
      if (value.byteLength > maximum - size) {
        cancel();
        throw new Error("Fixture response exceeded its byte limit.");
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function resolveBrowserFixtureDocument({
  configuration,
  identity,
  check,
  signal,
}: {
  configuration: BrowserFixtureConfiguration;
  identity: BrowserRunIdentity;
  check: BrowserVerificationPlan[number];
  signal: AbortSignal;
}): Promise<string | null> {
  const nonce = randomUUID();
  const purpose = { nonce, identity, path: check.path, regionTestId: check.regionTestId };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const requestOptions = {
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      signal,
    } satisfies RequestInit;
    const response = await fetch(configuration.brokerUrl, {
      ...requestOptions,
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.brokerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...purpose, policy: BROWSER_CAPTURE_POLICY }),
    });
    const payload: unknown = JSON.parse(
      decoder.decode(await boundedBody(response, maxBrokerBytes, "application/json", signal)),
    );
    const target = brokerResponseSchema.parse(payload);
    const url = new URL(target.previewUrl);
    const expiry = Date.parse(target.expiresAt);
    const now = Date.now();
    if (
      target.nonce !== purpose.nonce ||
      target.path !== purpose.path ||
      target.regionTestId !== purpose.regionTestId ||
      target.identity.runId !== identity.runId ||
      target.identity.attemptCount !== identity.attemptCount ||
      target.identity.commitSha !== identity.commitSha ||
      target.identity.treeSha !== identity.treeSha ||
      !Number.isFinite(expiry) ||
      expiry <= now ||
      expiry > now + maxTargetLifetimeMs ||
      url.origin !== configuration.previewOrigin ||
      url.pathname !== check.path ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }

    const document = await fetch(url, { ...requestOptions, headers: { Accept: "text/html" } });
    const bytes = await boundedBody(document, maxFixtureBytes, "text/html", signal);
    if (
      Date.now() >= expiry ||
      !bytes.length ||
      createHash("sha256").update(bytes).digest("hex") !== target.documentSha256
    ) {
      return null;
    }
    return decoder.decode(bytes);
  } catch {
    // Provider errors and ticket URLs must never enter receipts or run logs.
    return null;
  }
}
