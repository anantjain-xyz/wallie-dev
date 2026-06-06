// Utility functions migrated from lib/wallie/core.ts (Phase 0.2).
// These are used by the wallie panel UI and the service layer.

import type { Enums } from "@/lib/supabase/database.types";
import type {
  WallieBlockingReason,
  WallieSessionRepository,
  WallieRunMode,
  WallieVercelSandboxConnectionStatus,
} from "@/features/wallie/types";

export function inferWallieRunMode(githubRepositoryId: string | null | undefined): WallieRunMode {
  return githubRepositoryId ? "code" : "project";
}

export function parseWallieRunMode(
  value: string | null | undefined,
  fallback: WallieRunMode = "project",
): WallieRunMode {
  if (value === "code" || value === "project") {
    return value;
  }

  return fallback;
}

export function isWallieRunActiveStatus(status: Enums<"agent_run_status">) {
  return status === "queued" || status === "started" || status === "running";
}

export function isWallieRunTerminalStatus(status: Enums<"agent_run_status">) {
  return !isWallieRunActiveStatus(status);
}

export function canRetryWallieRun(status: Enums<"agent_run_status">, hasActiveRun: boolean) {
  return (status === "error" || status === "canceled") && !hasActiveRun;
}

export function buildWallieBlockingReasons(input: {
  hasActiveRun: boolean;
  missingSecretKeys: string[];
  mode: WallieRunMode;
  repository: WallieSessionRepository | null;
  requiresVercelSandbox?: boolean;
  vercelSandboxConnection: WallieVercelSandboxConnectionStatus;
}) {
  const reasons: WallieBlockingReason[] = [];
  const repositoryIsArchived = input.repository ? input.repository.isArchived : false;
  const requiresVercelSandbox = input.requiresVercelSandbox ?? true;
  const vercelConnection = input.vercelSandboxConnection;

  if (input.hasActiveRun) {
    reasons.push({
      code: "active_run",
      message:
        "A Wallie run is already queued or running for this session. Wait for it to finish before starting another run.",
    });
  }

  if (input.mode === "code" && !input.repository) {
    reasons.push({
      code: "repository_unavailable",
      message: "This run requires a linked repository. Link a GitHub repository before retrying.",
    });
  }

  if (input.mode === "code" && repositoryIsArchived) {
    reasons.push({
      code: "repository_archived",
      message: "Wallie cannot start a run against an archived repository.",
    });
  }

  if (input.missingSecretKeys.length > 0) {
    reasons.push({
      code: "missing_secret",
      message: `Wallie is missing required workspace secrets: ${input.missingSecretKeys.join(", ")}.`,
    });
  }

  if (!requiresVercelSandbox) {
    return reasons;
  }

  if (vercelConnection.status === "missing") {
    reasons.push({
      code: "vercel_sandbox_connection_missing",
      message:
        "Connect a Vercel Sandbox account in workspace settings before starting Wallie runs.",
    });
  } else if (!vercelConnection.connected) {
    reasons.push({
      code: "vercel_sandbox_connection_invalid",
      message:
        vercelConnection.lastValidationError ??
        "The saved Vercel Sandbox connection is invalid. Reconnect it in workspace settings.",
    });
  }

  return reasons;
}
