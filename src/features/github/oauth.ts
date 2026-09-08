import "server-only";

import { z } from "zod";

import { parseServerEnv } from "@/env/server";
import { buildAppUrl } from "@/lib/app-url";

type EnvInput = Record<string, string | undefined>;

const REQUEST_TIMEOUT_MS = 10_000;
const OWNERSHIP_TIMEOUT_MS = 30_000;
const INSTALLATIONS_PER_PAGE = 100;
const MAX_INSTALLATION_PAGES = 100;
const AUTHORIZATION_ERROR = "GitHub authorization could not be completed. Start connecting again.";
const OWNERSHIP_ERROR = "GitHub installation ownership could not be verified.";
const CONFIGURATION_ERROR = "GitHub OAuth is not configured.";
const githubIdSchema = z.number().int().positive().safe();
const tokenSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const githubLoginSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/);
const userSchema = z.object({ id: githubIdSchema, type: z.literal("User") });
const installationSchema = z.object({
  id: githubIdSchema,
  app_id: githubIdSchema,
  account: z.object({
    id: githubIdSchema,
    login: githubLoginSchema,
    type: z.string(),
  }),
  suspended_at: z.string().nullable(),
  target_type: z.string(),
});
const installationPageSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  installations: z.array(installationSchema).max(INSTALLATIONS_PER_PAGE),
});
const membershipSchema = z.object({
  role: z.literal("admin"),
  state: z.literal("active"),
  organization: z.object({ id: githubIdSchema }),
  user: z.object({ id: githubIdSchema }),
});

export function buildGitHubAuthorizationUrl(
  request: { state: string; codeChallenge: string },
  input: EnvInput = process.env,
): string {
  const { clientId, callbackUrl } = resolveOAuthConfiguration(input);
  if (
    !request.state ||
    request.state.length > 4096 ||
    !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)
  ) {
    throw new Error(AUTHORIZATION_ERROR);
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    state: request.state,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeGitHubAuthorizationCode(
  request: { code: string; codeVerifier: string },
  input: EnvInput = process.env,
): Promise<string> {
  const { clientId, clientSecret, callbackUrl } = resolveOAuthConfiguration(input);
  if (
    !request.code.trim() ||
    request.code.length > 4096 ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(request.codeVerifier)
  ) {
    throw new Error(AUTHORIZATION_ERROR);
  }

  try {
    const body = await fetchGitHubJson("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        code: request.code,
        code_verifier: request.codeVerifier,
      }),
    });
    const result = z
      .object({
        access_token: tokenSchema,
        token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
        error: z.undefined(),
      })
      .safeParse(body);
    if (!result.success) throw new Error(AUTHORIZATION_ERROR);
    // Refresh tokens are intentionally discarded. The user token lives only
    // long enough to prove ownership during this callback.
    return result.data.access_token;
  } catch {
    // Provider bodies, request details, and thrown fetch errors may contain
    // the client secret, authorization code, or token. Never propagate them.
    throw new Error(AUTHORIZATION_ERROR);
  }
}

export async function verifyGitHubInstallationOwnership(
  request: { installationId: number; token: string },
  input: EnvInput = process.env,
): Promise<void> {
  const { appId } = resolveOAuthConfiguration(input);
  if (!githubIdSchema.safeParse(request.installationId).success) {
    throw new Error(OWNERSHIP_ERROR);
  }
  if (!tokenSchema.safeParse(request.token).success) throw new Error(OWNERSHIP_ERROR);

  const signal = AbortSignal.timeout(OWNERSHIP_TIMEOUT_MS);
  try {
    const user = userSchema.parse(await githubUserGet("/user", request.token, signal));
    let seen = 0;
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      // Construct every page on the fixed API origin. Never forward the user
      // token to a URL from a Link header or an installation response.
      const result = installationPageSchema.parse(
        await githubUserGet(
          `/user/installations?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
          request.token,
          signal,
        ),
      );
      const installation = result.installations.find((item) => item.id === request.installationId);
      if (installation) {
        if (
          installation.app_id !== appId ||
          installation.suspended_at !== null ||
          installation.target_type !== installation.account.type
        ) {
          throw new Error(OWNERSHIP_ERROR);
        }
        const account = installation.account;
        if (account.type === "User") {
          if (account.id !== user.id) throw new Error(OWNERSHIP_ERROR);
          return;
        }
        if (account.type === "Organization") {
          // GET /user/installations also includes installations accessible to
          // repository readers. Only an active organization owner may delegate
          // installation-wide access to a Wallie workspace.
          const membership = membershipSchema.parse(
            await githubUserGet(
              `/user/memberships/orgs/${encodeURIComponent(account.login)}`,
              request.token,
              signal,
            ),
          );
          if (membership.organization.id !== account.id || membership.user.id !== user.id) {
            throw new Error(OWNERSHIP_ERROR);
          }
          return;
        }
        throw new Error(OWNERSHIP_ERROR);
      }
      seen += result.installations.length;
      if (seen >= result.total_count || result.installations.length < INSTALLATIONS_PER_PAGE) {
        break;
      }
    }
    throw new Error(OWNERSHIP_ERROR);
  } catch {
    throw new Error(OWNERSHIP_ERROR);
  }
}

function resolveOAuthConfiguration(input: EnvInput) {
  try {
    const env = parseServerEnv(input);
    const appId = Number(env.GITHUB_APP_ID);
    const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
    const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
    if (!githubIdSchema.safeParse(appId).success || !clientId || !clientSecret) {
      throw new Error(CONFIGURATION_ERROR);
    }
    return {
      appId,
      callbackUrl: buildAppUrl("/api/github/callback", input).toString(),
      clientId,
      clientSecret,
    };
  } catch {
    throw new Error(CONFIGURATION_ERROR);
  }
}

async function githubUserGet(path: string, token: string, signal: AbortSignal): Promise<unknown> {
  return fetchGitHubJson(`https://api.github.com${path}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
    signal,
  });
}

async function fetchGitHubJson(url: string, init: RequestInit): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal });
  if (!response.ok) throw new Error("GitHub request failed.");
  return response.json();
}
