import {
  Constants,
  type Enums,
  type Json,
  type Tables,
} from "@/lib/supabase/database.types";

export type IssueStatus = Enums<"issue_status">;
export type IssuePriority = Enums<"issue_priority">;
export type IssueLinkType = Enums<"issue_link_type">;
export type MemberKind = Enums<"member_kind">;
export type MemberRole = Enums<"member_role">;

export type IssueSortField = "priority" | "status" | "created" | "updated";
export type SortDirection = "asc" | "desc";

export const ISSUE_STATUS_VALUES = Constants.public.Enums.issue_status;
export const ISSUE_PRIORITY_VALUES = Constants.public.Enums.issue_priority;
export const ISSUE_LINK_TYPE_VALUES = Constants.public.Enums.issue_link_type;
export const ISSUE_SORT_FIELDS = [
  "priority",
  "status",
  "created",
  "updated",
] as const satisfies readonly IssueSortField[];
export const ISSUE_ESTIMATE_VALUES = [
  null,
  0,
  1,
  2,
  3,
  5,
  8,
  13,
] as const;

export type IssueEstimateValue = (typeof ISSUE_ESTIMATE_VALUES)[number];

export type IssueMember = {
  avatarUrl: string | null;
  fullName: string | null;
  id: string;
  isActive: boolean;
  kind: MemberKind;
  role: MemberRole;
  userId: string | null;
  username: string | null;
};

export type IssueViewerMember = IssueMember & {
  preferences: Json;
};

export type IssueSummary = {
  assignee: IssueMember | null;
  assigneeMemberId: string | null;
  createdAt: string;
  creator: IssueMember | null;
  creatorMemberId: string | null;
  descriptionMd: string;
  estimatePoints: number | null;
  githubRepositoryId: string | null;
  id: string;
  number: number;
  priority: IssuePriority;
  status: IssueStatus;
  title: string;
  updatedAt: string;
  workspaceId: string;
};

export type IssueDetail = IssueSummary & {
  designMd: string | null;
  planMd: string | null;
};

export type IssueComment = {
  author: IssueMember | null;
  authorMemberId: string | null;
  bodyMd: string;
  createdAt: string;
  id: string;
  issueId: string;
  updatedAt: string;
  workspaceId: string;
};

export type IssueListPreferences = {
  direction?: SortDirection;
  sort?: IssueSortField;
};

export type WorkspaceMemberRow = Pick<
  Tables<"workspace_members">,
  | "avatar_url"
  | "full_name"
  | "id"
  | "is_active"
  | "kind"
  | "role"
  | "user_id"
  | "username"
>;

export type WorkspaceViewerMemberRow = WorkspaceMemberRow & {
  preferences: Json;
};

export const ISSUE_PRIORITY_WEIGHTS: Record<IssuePriority, number> = {
  urgent: 5,
  high: 4,
  medium: 3,
  low: 2,
  none: 1,
};

export const ISSUE_STATUS_WEIGHTS: Record<IssueStatus, number> = {
  backlog: 1,
  todo: 2,
  in_progress: 3,
  in_review: 4,
  done: 5,
  canceled: 6,
};

export function formatIssueStatus(status: IssueStatus) {
  return status.replaceAll("_", " ");
}

export function formatIssuePriority(priority: IssuePriority) {
  return priority === "none" ? "no priority" : priority;
}

export function formatIssueEstimate(estimatePoints: number | null) {
  if (estimatePoints === null) {
    return "No estimate";
  }

  const pointLabel = estimatePoints === 1 ? "point" : "points";

  return `${estimatePoints} ${pointLabel}`;
}

export function getIssueMemberDisplayName(member: IssueMember | null) {
  if (!member) {
    return "Unassigned";
  }

  return member.fullName ?? member.username ?? "Unknown member";
}

export function isWorkspaceManager(member: Pick<IssueMember, "role"> | null) {
  return member?.role === "owner" || member?.role === "admin";
}
