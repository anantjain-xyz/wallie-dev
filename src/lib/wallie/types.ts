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
