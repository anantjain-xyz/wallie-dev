import { workspaceFailureGroupPath } from "@/lib/routes";

export function failureValidationPath(
  workspaceSlug: string,
  cohortId: string,
  memberId: string,
  query: Parameters<typeof workspaceFailureGroupPath>[2],
) {
  return `${workspaceFailureGroupPath(workspaceSlug, cohortId)}/validation/${encodeURIComponent(memberId)}${new URL(workspaceFailureGroupPath(workspaceSlug, cohortId, query), "http://localhost").search}`;
}
