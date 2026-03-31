import type { Enums } from "@/lib/supabase/database.types";
import { WALLIE_FREE_TIER_RUN_LIMIT } from "@/lib/wallie/constants";
import type {
  WallieBillingSnapshot,
  WallieBillingState,
  WallieBlockingReason,
  WallieRunMode,
} from "@/lib/wallie/types";

export function inferWallieRunMode(
  githubRepositoryId: string | null | undefined,
): WallieRunMode {
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

export function canRetryWallieRun(
  status: Enums<"agent_run_status">,
  hasActiveRun: boolean,
) {
  return isWallieRunTerminalStatus(status) && !hasActiveRun;
}

export function buildWallieBillingState(
  input: WallieBillingSnapshot,
): WallieBillingState {
  const runLimit =
    input.tier === "free" ? WALLIE_FREE_TIER_RUN_LIMIT : null;
  const runsRemaining =
    runLimit === null
      ? null
      : Math.max(runLimit - input.successfulRunsThisCycle, 0);

  return {
    ...input,
    limitReached: runLimit !== null && input.successfulRunsThisCycle >= runLimit,
    runLimit,
    runsRemaining,
  };
}

export function buildWallieBlockingReasons(input: {
  billing: WallieBillingState;
  hasActiveRun: boolean;
  missingSecretKeys: string[];
  mode: WallieRunMode;
  repository: {
    isArchived?: boolean;
    is_archived?: boolean;
  } | null;
}) {
  const reasons: WallieBlockingReason[] = [];
  const repositoryIsArchived =
    input.repository?.isArchived ?? input.repository?.is_archived ?? false;

  if (input.hasActiveRun) {
    reasons.push({
      code: "active_run",
      message:
        "A Wallie run is already queued or running for this issue. Wait for it to finish before starting another run.",
    });
  }

  if (input.mode === "code" && !input.repository) {
    reasons.push({
      code: "repository_unavailable",
      message:
        "Code mode requires a linked repository. Link a GitHub repository on this issue before running Wallie.",
    });
  }

  if (input.mode === "code" && repositoryIsArchived) {
    reasons.push({
      code: "repository_archived",
      message:
        "Wallie cannot start a code-mode run against an archived repository.",
    });
  }

  if (input.missingSecretKeys.length > 0) {
    reasons.push({
      code: "missing_secret",
      message: `Wallie is missing required workspace secrets: ${input.missingSecretKeys.join(", ")}.`,
    });
  }

  if (input.billing.limitReached) {
    const limitLabel = input.billing.runLimit ?? WALLIE_FREE_TIER_RUN_LIMIT;

    reasons.push({
      code: "billing_limit_reached",
      message: `This workspace has reached its ${limitLabel}-run Wallie limit for the current billing cycle.`,
    });
  }

  return reasons;
}

export function formatWallieRunMode(mode: WallieRunMode) {
  return mode === "code" ? "Code mode" : "Project mode";
}

export function shouldResetFreeTierBillingCycle(
  currentBillingCycleStartAt: string,
  now = new Date(),
) {
  const cycleStart = new Date(currentBillingCycleStartAt);

  if (Number.isNaN(cycleStart.getTime())) {
    return false;
  }

  cycleStart.setMonth(cycleStart.getMonth() + 1);

  return cycleStart <= now;
}
