import type { CodexAuthJsonMetadata } from "@/lib/codex/contracts";

interface ParsedJwtPayload {
  email?: unknown;
  sub?: unknown;
}

interface CodexAuthJsonShape {
  auth_mode?: unknown;
  last_refresh?: unknown;
  tokens?: {
    access_token?: unknown;
    id_token?: unknown;
    refresh_token?: unknown;
  };
}

export function parseCodexChatGptAuthJson(raw: string): CodexAuthJsonMetadata {
  let parsed: CodexAuthJsonShape;
  try {
    parsed = JSON.parse(raw) as CodexAuthJsonShape;
  } catch {
    throw new Error("Codex auth cache must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Codex auth cache must be a JSON object.");
  }

  if (parsed.auth_mode !== "chatgpt") {
    throw new Error('Codex auth cache must have auth_mode "chatgpt".');
  }

  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object") {
    throw new Error("Codex auth cache is missing tokens.");
  }

  if (typeof tokens.access_token !== "string" || tokens.access_token.length < 20) {
    throw new Error("Codex auth cache is missing an access token.");
  }

  if (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length < 20) {
    throw new Error("Codex auth cache is missing a refresh token.");
  }

  const idTokenPayload =
    typeof tokens.id_token === "string" ? decodeJwtPayload(tokens.id_token) : null;

  return {
    accountEmail:
      typeof idTokenPayload?.email === "string" && idTokenPayload.email.includes("@")
        ? idTokenPayload.email
        : null,
    accountId: typeof idTokenPayload?.sub === "string" ? idTokenPayload.sub : null,
    lastRefresh: normalizeLastRefresh(parsed.last_refresh),
  };
}

function normalizeLastRefresh(value: unknown): string | null {
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  return null;
}

function decodeJwtPayload(token: string): ParsedJwtPayload | null {
  const [, payload] = token.split(".");
  if (!payload) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ParsedJwtPayload;
  } catch {
    return null;
  }
}
