import "server-only";

import type { WorkspaceSummary } from "@/lib/auth";
import type { Tables } from "@/lib/supabase/database.types";
import { mapIssueRow } from "@/features/issues/model";
import { loadIssueWorkspaceContext } from "@/features/issues/server";
import type {
  IssueEstimateValue,
  IssueListPreferences,
  IssueMember,
  IssuePriority,
  IssueSortField,
  IssueStatus,
  IssueSummary,
  IssueViewerMember,
  SortDirection,
} from "@/features/issues/types";
import { ISSUE_PRIORITY_WEIGHTS, ISSUE_STATUS_WEIGHTS } from "@/features/issues/types";
import {
  parseIssueListQueryState,
  readIssueListPreferences,
  type IssueListQueryState,
  type SearchParamInput,
} from "@/features/issues/list/query-state";

export type IssueListPageData = {
  currentMember: IssueViewerMember | null;
  issues: IssueSummary[];
  members: IssueMember[];
  queryState: IssueListQueryState;
  totalIssueCount: number;
  workspace: WorkspaceSummary;
};

function compareNumbers(left: number, right: number, direction: SortDirection) {
  return direction === "asc" ? left - right : right - left;
}

function compareDates(left: string, right: string, direction: SortDirection) {
  return compareNumbers(new Date(left).getTime(), new Date(right).getTime(), direction);
}

function matchesSearch(issue: IssueSummary, query: string) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLocaleLowerCase();

  return (
    issue.title.toLocaleLowerCase().includes(normalizedQuery) ||
    issue.descriptionMd.toLocaleLowerCase().includes(normalizedQuery)
  );
}

function matchesStatus(issue: IssueSummary, statuses: IssueStatus[]) {
  return statuses.length === 0 || statuses.includes(issue.status);
}

function matchesPriority(issue: IssueSummary, priorities: IssuePriority[]) {
  return priorities.length === 0 || priorities.includes(issue.priority);
}

function matchesEstimate(issue: IssueSummary, estimates: IssueEstimateValue[]) {
  return estimates.length === 0 || estimates.includes(issue.estimatePoints as IssueEstimateValue);
}

function compareBySortField(
  left: IssueSummary,
  right: IssueSummary,
  sort: IssueSortField,
  direction: SortDirection,
) {
  switch (sort) {
    case "priority":
      return compareNumbers(
        ISSUE_PRIORITY_WEIGHTS[left.priority],
        ISSUE_PRIORITY_WEIGHTS[right.priority],
        direction,
      );
    case "status":
      return compareNumbers(
        ISSUE_STATUS_WEIGHTS[left.status],
        ISSUE_STATUS_WEIGHTS[right.status],
        direction,
      );
    case "created":
      return compareDates(left.createdAt, right.createdAt, direction);
    case "updated":
      return compareDates(left.updatedAt, right.updatedAt, direction);
    default:
      return 0;
  }
}

function filterAndSortIssues(issues: IssueSummary[], queryState: IssueListQueryState) {
  return issues
    .filter(
      (issue) =>
        matchesSearch(issue, queryState.query) &&
        matchesStatus(issue, queryState.statuses) &&
        matchesPriority(issue, queryState.priorities) &&
        matchesEstimate(issue, queryState.estimates),
    )
    .sort((left, right) => {
      const primary = compareBySortField(left, right, queryState.sort, queryState.direction);

      if (primary !== 0) {
        return primary;
      }

      const updated = compareDates(left.updatedAt, right.updatedAt, "desc");

      if (updated !== 0) {
        return updated;
      }

      return compareNumbers(left.number, right.number, "desc");
    });
}

export async function loadIssueListPageData(workspaceSlug: string, searchParams: SearchParamInput) {
  const context = await loadIssueWorkspaceContext(workspaceSlug);
  const preferences: IssueListPreferences = readIssueListPreferences(
    context.currentMember?.preferences,
  );
  const queryState = parseIssueListQueryState(searchParams, preferences);
  const { data, error } = await context.supabase
    .from("issues")
    .select("*")
    .eq("workspace_id", context.workspace.id);

  if (error) {
    throw error;
  }

  const issues = ((data ?? []) as Tables<"issues">[]).map((issue) =>
    mapIssueRow(issue, context.memberIndex),
  );

  return {
    currentMember: context.currentMember,
    issues: filterAndSortIssues(issues, queryState),
    members: context.members.filter((member) => member.isActive),
    queryState,
    totalIssueCount: issues.length,
    workspace: context.workspace,
  } satisfies IssueListPageData;
}
