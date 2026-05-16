export const OAUTH_PROVIDERS = ["github", "google"] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
