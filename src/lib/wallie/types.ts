import type { Enums } from "@/lib/supabase/database.types";

export type WallieRunMode = "code" | "project";

export type WallieBlockingCode =
  | "active_run"
  | "billing_limit_reached"
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

export type WallieBillingSnapshot = {
  currentBillingCycleStartAt: string;
  successfulRunsThisCycle: number;
  tier: Enums<"workspace_tier">;
};

export type WallieBillingState = WallieBillingSnapshot & {
  limitReached: boolean;
  runLimit: number | null;
  runsRemaining: number | null;
};
