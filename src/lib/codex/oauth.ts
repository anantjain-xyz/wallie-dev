import { createHash, randomBytes } from "node:crypto";

/**
 * Codex CLI public OAuth client. This is the client_id the Codex CLI ships
 * with when it performs "Sign in with ChatGPT". We reuse it from the web
 * app because OpenAI does not currently offer a third-party OAuth client
 * for Codex/ChatGPT entitlements. Overridable via env for local testing
 * and to allow a swap if OpenAI publishes a dedicated client.
 */
export const CODEX_CLIENT_ID =
  process.env.CODEX_OAUTH_CLIENT_ID?.trim() || "app_EMoamEEZ73f0CkXaXp7hrann";

export const CODEX_AUTHORIZE_URL =
  process.env.CODEX_OAUTH_AUTHORIZE_URL?.trim() || "https://auth.openai.com/oauth/authorize";

export const CODEX_TOKEN_URL =
  process.env.CODEX_OAUTH_TOKEN_URL?.trim() || "https://auth.openai.com/oauth/token";

/**
 * Scopes the Codex CLI requests. `offline_access` is required to obtain a
 * refresh token.
 */
export const CODEX_SCOPES = "openid profile email offline_access";

export const CODEX_OAUTH_COOKIE = "wallie_codex_oauth";

/** Short-lived cookie TTL (seconds) covering the OAuth round-trip. */
export const CODEX_OAUTH_COOKIE_MAX_AGE = 10 * 60;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * Generate a PKCE verifier (high-entropy random) and its S256 challenge.
 */
export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export function buildCodexAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: CODEX_SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${CODEX_AUTHORIZE_URL}?${params.toString()}`;
}

export interface CodexTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

async function postTokenRequest(body: URLSearchParams): Promise<CodexTokenResponse> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token endpoint returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as Partial<CodexTokenResponse>;
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Codex token response is missing required fields.");
  }
  return json as CodexTokenResponse;
}

export function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<CodexTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CODEX_CLIENT_ID,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  return postTokenRequest(body);
}

export function refreshAccessToken(refreshToken: string): Promise<CodexTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CODEX_CLIENT_ID,
    refresh_token: refreshToken,
    scope: CODEX_SCOPES,
  });
  return postTokenRequest(body);
}

export interface CodexIdentity {
  email: string | null;
  accountId: string | null;
}

/**
 * Extract `email` and `sub` from an id_token without verifying the signature.
 * Used only for display; authorization still rests on the access token.
 */
export function readIdentityFromIdToken(idToken: string | undefined): CodexIdentity {
  if (!idToken) return { email: null, accountId: null };
  const parts = idToken.split(".");
  if (parts.length < 2) return { email: null, accountId: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      email?: unknown;
      sub?: unknown;
    };
    return {
      email: typeof payload.email === "string" ? payload.email : null,
      accountId: typeof payload.sub === "string" ? payload.sub : null,
    };
  } catch {
    return { email: null, accountId: null };
  }
}
