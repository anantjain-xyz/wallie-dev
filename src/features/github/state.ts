import { createHmac, timingSafeEqual } from "node:crypto";

import { parseServerEnv } from "@/env/server";

const githubStateVersion = 1;
const maxStateAgeMs = 60 * 60 * 1000;

export type GitHubInstallState = {
  createdAt: string;
  userId: string;
  version: 1;
  workspaceId: string;
  workspaceSlug: string;
};

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getSigningKey(input: Record<string, string | undefined> = process.env) {
  return parseServerEnv(input).WALLIE_ENCRYPTION_KEY;
}

function createSignature(
  payload: string,
  input: Record<string, string | undefined> = process.env,
) {
  return createHmac("sha256", getSigningKey(input))
    .update(payload)
    .digest("base64url");
}

export function createGitHubInstallState(
  payload: Omit<GitHubInstallState, "createdAt" | "version">,
  input: Record<string, string | undefined> = process.env,
) {
  const encodedPayload = encodeBase64Url(
    JSON.stringify({
      ...payload,
      createdAt: new Date().toISOString(),
      version: githubStateVersion,
    } satisfies GitHubInstallState),
  );
  const signature = createSignature(encodedPayload, input);

  return `${encodedPayload}.${signature}`;
}

export function verifyGitHubInstallState(
  token: string | null | undefined,
  input: Record<string, string | undefined> = process.env,
) {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createSignature(encodedPayload, input);
  const validSignature =
    expectedSignature.length === signature.length &&
    timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));

  if (!validSignature) {
    return null;
  }

  let parsed: GitHubInstallState;

  try {
    parsed = JSON.parse(decodeBase64Url(encodedPayload)) as GitHubInstallState;
  } catch {
    return null;
  }

  if (parsed.version !== githubStateVersion) {
    return null;
  }

  const ageMs = Date.now() - new Date(parsed.createdAt).getTime();

  if (Number.isNaN(ageMs) || ageMs < 0 || ageMs > maxStateAgeMs) {
    return null;
  }

  return parsed;
}
