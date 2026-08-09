export function buildWallieJobDedupeKey(sessionId: string) {
  return `session:${sessionId}:active`;
}
