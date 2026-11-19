import { z } from "zod";

import { factoryCommandScopesSchema } from "@/lib/factory-machine-tokens/contracts";

export const factoryOAuthHeaders = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

const reservedResponseParams = ["code", "error", "error_description", "error_uri", "state", "iss"];
const loopbackRedirect = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}(?:[/?]|$)/i;
const maxFormBytes = 4096;
const invalidPercentEscape = /%(?![0-9a-f]{2})/i;

export const factoryOAuthRedirectUriSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!/^[\x21-\x7e]+$/.test(value) || /[#\\]/.test(value)) return false;
    if (invalidPercentEscape.test(value)) return false;
    const authority = value.match(/^https?:\/\/([^/?]+)/i)?.[1];
    if (!authority || authority.includes("@") || authority.includes("*")) return false;
    try {
      const url = new URL(value);
      if (url.username || url.password) return false;
      if (url.protocol !== "https:" && !loopbackRedirect.test(value)) return false;
      return reservedResponseParams.every((name) => !url.searchParams.has(name));
    } catch {
      return false;
    }
  });

const clientIdSchema = z.string().uuid();
const authorizeSchema = z.object({
  clientId: clientIdSchema,
  redirectUri: factoryOAuthRedirectUriSchema,
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  method: z.literal("S256"),
  state: z
    .string()
    .max(512)
    .regex(/^[\x20-\x7e]+$/)
    .optional(),
});
const authorizationCodeSchema = z.object({
  redirectUri: factoryOAuthRedirectUriSchema,
  code: z.string().min(1).max(128),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
const refreshTokenSchema = z.string().min(1).max(128);

function parseScopes(value: string | undefined) {
  return factoryCommandScopesSchema.safeParse(value?.split(" "));
}

function readParameters(params: URLSearchParams) {
  const unique = new Map<string, string>();
  for (const [name, value] of params) {
    if (unique.has(name)) return null;
    unique.set(name, value);
  }
  return unique;
}

export function parseFactoryOAuthAuthorization(params: URLSearchParams) {
  const fields = readParameters(params);
  const responseType = fields?.get("response_type");
  if (!fields || !responseType) return { ok: false, error: "invalid_request" } as const;
  const authorization = authorizeSchema.safeParse({
    clientId: fields.get("client_id"),
    redirectUri: fields.get("redirect_uri"),
    challenge: fields.get("code_challenge"),
    method: fields.get("code_challenge_method"),
    state: fields.get("state") || undefined,
  });
  if (!authorization.success) return { ok: false, error: "invalid_request" } as const;
  if (responseType !== "code") return { ok: false, error: "unsupported_response_type" } as const;
  const scopes = parseScopes(fields.get("scope"));
  if (!scopes.success) return { ok: false, error: "invalid_scope" } as const;

  const { clientId, redirectUri, challenge, state } = authorization.data;
  return {
    ok: true,
    request: { clientId, redirectUri, challenge, state, scopes: scopes.data },
  } as const;
}

export function parseFactoryOAuthToken(params: URLSearchParams) {
  const fields = readParameters(params);
  const client = clientIdSchema.safeParse(fields?.get("client_id"));
  const grantType = fields?.get("grant_type");
  if (!fields || !client.success || !grantType || fields.has("client_secret")) {
    return { ok: false, error: "invalid_request" } as const;
  }
  if (grantType === "authorization_code") {
    const code = authorizationCodeSchema.safeParse({
      redirectUri: fields.get("redirect_uri"),
      code: fields.get("code"),
      verifier: fields.get("code_verifier"),
    });
    if (!code.success) return { ok: false, error: "invalid_request" } as const;
    return {
      ok: true,
      request: { kind: "authorization_code", clientId: client.data, ...code.data },
    } as const;
  }
  if (grantType === "refresh_token") {
    const refresh = refreshTokenSchema.safeParse(fields.get("refresh_token"));
    if (!refresh.success) return { ok: false, error: "invalid_request" } as const;
    const requestedScope = fields.get("scope");
    const scopes = requestedScope ? parseScopes(requestedScope) : null;
    if (scopes && !scopes.success) return { ok: false, error: "invalid_scope" } as const;
    return {
      ok: true,
      request: {
        kind: "refresh_token",
        clientId: client.data,
        refreshToken: refresh.data,
        scopes: scopes?.data,
      },
    } as const;
  }
  return { ok: false, error: "unsupported_grant_type" } as const;
}

export async function readFactoryOAuthForm(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const length = request.headers.get("content-length");
  if (
    contentType !== "application/x-www-form-urlencoded" ||
    !request.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maxFormBytes))
  ) {
    return null;
  }

  const bytes = new Uint8Array(maxFormBytes);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > maxFormBytes - offset) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }

    const form = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    if (invalidPercentEscape.test(form)) return null;
    return new URLSearchParams(form);
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

type AuthorizationResponse =
  | { kind: "code"; code: string }
  | {
      kind: "error";
      error:
        | "access_denied"
        | "invalid_request"
        | "invalid_scope"
        | "unsupported_response_type"
        | "server_error";
    };

/** Call only after the database has confirmed the exact registered redirect. */
export function factoryOAuthRedirect(input: {
  redirectUri: string;
  state?: string;
  response: AuthorizationResponse;
}) {
  const { redirectUri, state, response } = input;
  const params =
    response.kind === "code"
      ? new URLSearchParams({ code: response.code })
      : new URLSearchParams({ error: response.error });
  if (state !== undefined) params.set("state", state);
  const separator = redirectUri.includes("?") ? "&" : "?";
  return new URL(`${redirectUri}${separator}${params}`);
}
