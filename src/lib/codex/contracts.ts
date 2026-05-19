export const CODEX_CREDENTIAL_TYPES = [
  "chatgpt_auth_json",
  "codex_access_token",
  "platform_api_key",
] as const;

export type CodexCredentialType = (typeof CODEX_CREDENTIAL_TYPES)[number];

interface BaseCodexCredential {
  expiresAt: string | null;
  secret: string;
  userId?: string;
}

export interface ChatGptCodexCredential extends BaseCodexCredential {
  authCacheLastRefresh: string | null;
  credentialVersion: number;
  reconnectReason: string | null;
  reconnectRequired: boolean;
  type: "chatgpt_auth_json";
  userId: string;
}

export interface CodexAccessTokenCredential extends BaseCodexCredential {
  type: "codex_access_token";
}

export interface PlatformApiKeyCredential extends BaseCodexCredential {
  expiresAt: null;
  type: "platform_api_key";
}

export type CodexCredential =
  | ChatGptCodexCredential
  | CodexAccessTokenCredential
  | PlatformApiKeyCredential;

export interface CodexAuthJsonMetadata {
  accountEmail: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}

export interface CodexChatGptAuthStore {
  acquireChatGptAuthLease(input: {
    leaseExpiresAt: string;
    runId: string;
    userId: string;
  }): Promise<ChatGptCodexCredential | null>;
  markChatGptAuthReconnectRequired(input: {
    reason: string;
    runId: string;
    userId: string;
  }): Promise<void>;
  persistChatGptAuthJson(input: {
    authJson: string;
    metadata: CodexAuthJsonMetadata;
    previousCredentialVersion: number;
    runId: string;
    userId: string;
  }): Promise<boolean>;
  releaseChatGptAuthLease(input: { runId: string; userId: string }): Promise<void>;
}

export class CodexAuthLeaseBusyError extends Error {
  constructor(message = "Codex ChatGPT auth is already in use by another run.") {
    super(message);
    this.name = "CodexAuthLeaseBusyError";
  }
}

export function isCodexAuthLeaseBusyError(error: unknown): error is CodexAuthLeaseBusyError {
  return error instanceof CodexAuthLeaseBusyError;
}

export interface CodexCredentialStatusRow {
  access_token_expires_at: string | null;
  account_email: string | null;
  auth_cache_last_refresh: string | null;
  auth_reconnect_reason: string | null;
  auth_reconnect_required: boolean;
  credential_type: CodexCredentialType;
  updated_at: string;
}

export interface CodexCredentialConnectionStatus {
  accountEmail: string | null;
  authCacheLastRefresh: string | null;
  connected: boolean;
  credentialType: CodexCredentialType;
  expired: boolean;
  expiresAt: string | null;
  reconnectReason: string | null;
  reconnectRequired: boolean;
  updatedAt: string;
}

export function mapCodexCredentialConnectionStatus(
  row: CodexCredentialStatusRow,
): CodexCredentialConnectionStatus {
  const expired = credentialExpired(row.access_token_expires_at);
  const reconnectRequired =
    row.credential_type === "chatgpt_auth_json" && row.auth_reconnect_required;

  return {
    accountEmail: row.account_email,
    authCacheLastRefresh: row.auth_cache_last_refresh,
    connected: !expired && !reconnectRequired,
    credentialType: row.credential_type,
    expired,
    expiresAt: row.access_token_expires_at,
    reconnectReason: row.auth_reconnect_reason,
    reconnectRequired,
    updatedAt: row.updated_at,
  };
}

export function credentialExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

export function isCodexCredentialType(value: string): value is CodexCredentialType {
  return CODEX_CREDENTIAL_TYPES.includes(value as CodexCredentialType);
}

export function codexCredentialTypeLabel(type: CodexCredentialType): string {
  switch (type) {
    case "chatgpt_auth_json":
      return "ChatGPT subscription";
    case "codex_access_token":
      return "Codex access token (Business/Enterprise)";
    case "platform_api_key":
      return "OpenAI API key";
  }
}
