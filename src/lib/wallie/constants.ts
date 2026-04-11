export const WALLIE_MODEL_NAME = "wallie-control-plane-stub";
export const WALLIE_MODEL_PROVIDER = "anthropic";
export const WALLIE_PROCESS_TOKEN_ENV_KEY = "WALLIE_PROCESS_TOKEN";
export const WALLIE_REQUIRED_SECRET_KEYS = ["ANTHROPIC_API_KEY"] as const;

export function buildWallieJobDedupeKey(issueId: string) {
  return `issue:${issueId}:active`;
}
