export interface OpenCodeCredential {
  secret: string;
}

export interface OpenCodeProviderCredentialMeta {
  providerId: string;
  updatedAt: string;
}

export interface OpenCodeAuth {
  /** Zen API key for the reserved `opencode` provider, if connected. */
  credential: OpenCodeCredential | null;
  /** Custom provider keys keyed by OpenCode provider id. Never includes `opencode`. */
  providerCredentials: Record<string, OpenCodeCredential>;
}
