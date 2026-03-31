import type { IssueMember } from "@/features/issues/types";
import type { Enums } from "@/lib/supabase/database.types";
import type {
  WallieBillingState,
  WallieBlockingReason,
  WallieRunMode,
} from "@/lib/wallie/types";

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
  triggeredByMember: IssueMember | null;
  triggeredByMemberId: string | null;
};

export type WallieIssueData = {
  billing: WallieBillingState;
  blockingReasons: WallieBlockingReason[];
  canEnqueue: boolean;
  missingSecretKeys: string[];
  mode: WallieRunMode;
  repository: WallieIssueRepository | null;
  requiredSecretKeys: string[];
  runs: WallieRun[];
};
