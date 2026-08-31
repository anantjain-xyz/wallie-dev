/** Shared Wallie stage branch naming — keep in sync with pipeline checkout. */
export function buildStageBranchName(sessionId: string, stageSlug: string): string {
  const safeSlug = stageSlug.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `wallie/${safeSlug || "stage"}-${sessionId}`;
}
