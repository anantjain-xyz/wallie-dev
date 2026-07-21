import type { WorkspaceMember } from "@/features/workspace-members/types";
import type { Enums } from "@/lib/supabase/database.types";

// --- Types migrated from lib/wallie/types.ts (Phase 0.2) ---

export type WallieRunMode = "code" | "project";

export type WallieBlockingCode =
  | "active_run"
  | "missing_secret"
  | "repository_archived"
  | "repository_unavailable"
  | "sandbox_connection_invalid"
  | "sandbox_connection_missing"
  | "sandbox_capability_check_stale"
  /** @deprecated Kept while older clients migrate to provider-neutral codes. */
  | "vercel_sandbox_connection_invalid"
  | "vercel_sandbox_connection_missing";

export type WallieActionErrorCode =
  | WallieBlockingCode
  | "run_lookup_timeout"
  | "session_not_found"
  | "session_archived"
  | "session_not_runnable"
  | "run_not_found"
  | "run_not_retryable";

export type WallieBlockingReason = {
  code: WallieBlockingCode;
  message: string;
  provider?: "vercel" | "e2b" | "daytona";
};

export type WallieVercelSandboxConnectionStatus = {
  connected: boolean;
  connectionRevision?: string | null;
  displayName?: string | null;
  lastValidationError: string | null;
  provider?: "vercel" | "e2b" | "daytona";
  providerLabel?: string;
  projectId: string | null;
  projectName: string | null;
  status: "connected" | "error" | "missing";
  teamId: string | null;
};

export type WallieSessionRepository = {
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
  attemptCount: number;
  canCancel: boolean;
  canRetry: boolean;
  createdAt: string;
  finishedAt: string | null;
  id: string;
  isActive: boolean;
  isTerminal: boolean;
  lastActivityAt: string | null;
  messages: WallieRunMessage[];
  modelName: string;
  modelProvider: string;
  requestedByMember: WorkspaceMember | null;
  requestedByMemberId: string | null;
  runType: WallieRunMode;
  sandboxId: string | null;
  sandboxProvider: string | null;
  startedAt: string | null;
  stageId: string | null;
  stageName: string | null;
  stageSlug: string | null;
  status: Enums<"agent_run_status">;
  updatedAt: string;
};

export type WallieRunCursor = {
  createdAt: string;
  id: string;
};

export type WallieRunPage = {
  nextCursor: WallieRunCursor | null;
  runs: WallieRun[];
};

export type WallieSessionData = {
  blockingReasons: WallieBlockingReason[];
  canEnqueue: boolean;
  loadedMessageRunIds: string[];
  missingSecretKeys: string[];
  mode: WallieRunMode;
  nextRunCursor: WallieRunCursor | null;
  repository: WallieSessionRepository | null;
  requiresVercelSandbox: boolean;
  requiredSecretKeys: string[];
  runs: WallieRun[];
  /** Workspace stall timeout used by the worker; UI mirrors it for "No recent activity". */
  stallTimeoutMs: number;
  vercelSandboxConnection: WallieVercelSandboxConnectionStatus;
  workspaceMembers: WorkspaceMember[];
};
