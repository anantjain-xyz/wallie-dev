/**
 * Worker stand-in for `@vercel/oidc`.
 *
 * Workerd selects that package's `browser` export. The browser build still
 * evaluates `verify-vercel-oidc-token.js`, which `require()`s `jose`. The
 * Vitest worker pool loads that file with `mf_vitest_no_cjs_esm_shim`, so the
 * `jose` namespace is undefined and `createRemoteJWKSet` throws while the
 * module is still loading.
 *
 * Sandbox calls pass `token`, `teamId`, and `projectId`, so this module is
 * only reached for OIDC refresh. Refresh runs solely for JWT credentials.
 * Throwing leaves the caller's existing token in place (`ensureValidToken`
 * ignores the error). Returning an empty string would replace it.
 */
function readOidcToken() {
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error(
      "Vercel OIDC refresh is not available in the Cloudflare worker. Pass token, teamId, and projectId.",
    );
  }
  return token;
}

export class AccessTokenMissingError extends Error {
  constructor() {
    super("Vercel access token missing");
    this.name = "AccessTokenMissingError";
  }
}

export class RefreshAccessTokenFailedError extends Error {
  constructor(message = "Failed to refresh Vercel access token") {
    super(message);
    this.name = "RefreshAccessTokenFailedError";
  }
}

export function getContext() {
  return {};
}

export function getVercelOidcTokenSync() {
  return readOidcToken();
}

export async function getVercelOidcToken() {
  return readOidcToken();
}

export async function getVercelToken() {
  throw new Error("getVercelToken is not supported in the Cloudflare worker");
}

export async function exchangeVercelOidcToken() {
  throw new Error("exchangeVercelOidcToken is not supported in the Cloudflare worker");
}

export async function verifyVercelOidcToken() {
  throw new Error("verifyVercelOidcToken is not supported in the Cloudflare worker");
}
