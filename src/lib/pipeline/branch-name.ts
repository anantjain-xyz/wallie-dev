/** Each job attempt publishes to its own branch, including retried jobs. */
export function buildStageBranchName(
  sessionId: string,
  stageSlug: string,
  execution: { jobId: string; attemptCount: number },
): string {
  return `${buildLegacyStageBranchName(sessionId, stageSlug)}-job-${execution.jobId}-attempt-${execution.attemptCount}`;
}

/** Historical runs use this prefix without an execution suffix. */
export function buildLegacyStageBranchName(sessionId: string, stageSlug: string): string {
  const safeSlug = stageSlug.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `wallie/${safeSlug || "stage"}-${sessionId}`;
}
