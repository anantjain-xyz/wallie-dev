export const CODEX_CREDENTIAL_TYPES = ["codex_access_token", "platform_api_key"] as const;

export type CodexCredentialType = (typeof CODEX_CREDENTIAL_TYPES)[number];

export interface CodexCredential {
  expiresAt: string | null;
  secret: string;
  type: CodexCredentialType;
}

export function codexCredentialTypeLabel(type: CodexCredentialType): string {
  switch (type) {
    case "codex_access_token":
      return "Codex access token";
    case "platform_api_key":
      return "OpenAI API key";
  }
}
