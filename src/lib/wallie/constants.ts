export const WALLIE_REQUIRED_SECRET_KEYS = [] as const;
export const PIPELINE_REQUIRED_SECRET_KEYS = ["LINEAR_API_KEY"] as const;

export function buildWallieJobDedupeKey(sessionId: string) {
  return `session:${sessionId}:active`;
}
