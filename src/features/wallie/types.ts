import type { WorkspaceMember } from "@/features/workspace-members/types";
import type { Enums } from "@/lib/supabase/database.types";

// --- Types migrated from lib/wallie/types.ts (Phase 0.2) ---

export type WallieRunMode = "code" | "project";

export type WallieBlockingCode =
  | "active_run"
  | "missing_secret"
  | "repository_archived"
  | "repository_unavailable";

export type WallieActionErrorCode =
  | WallieBlockingCode
  | "issue_not_found"
  | "run_not_found"
  | "run_not_retryable";

export type WallieBlockingReason = {
  code: WallieBlockingCode;
  message: string;
};

export type WallieIssueRepository = {
  defaultBranch: string | null;
  defaultProgrammingLanguage: string | null;
  fullName: string;
  htmlUrl: string;
  id: string;
  isArchived: boolean;
  isPrivate: boolean;
};

export type WallieRunMessage = {
  createdAt: string;
  id: string;
  kind: string;
  messageMd: string;
};

export type WallieRun = {
  canRetry: boolean;
  createdAt: string;
  finishedAt: string | null;
  id: string;
  isActive: boolean;
  isTerminal: boolean;
  messages: WallieRunMessage[];
  modelName: string;
  modelProvider: string;
  runType: WallieRunMode;
  startedAt: string | null;
  status: Enums<"agent_run_status">;
  triggeredByMember: WorkspaceMember | null;
  triggeredByMemberId: string | null;
};

export type WallieIssueData = {
  blockingReasons: WallieBlockingReason[];
  canEnqueue: boolean;
  missingSecretKeys: string[];
  mode: WallieRunMode;
  repository: WallieIssueRepository | null;
  requiredSecretKeys: string[];
  runs: WallieRun[];
};
