import type { SessionPhaseStatus } from "@/features/sessions/types";

export type SessionMutationErrorCode =
  | "archived"
  | "forbidden"
  | "invalid_input"
  | "invalid_state"
  | "mutation_conflict"
  | "mutation_failed"
  | "not_found"
  | "rate_limited"
  | "stale_version"
  | "unauthorized";

export type SessionMutationErrorResponse = {
  code: SessionMutationErrorCode;
  error: string;
};

export type SessionTitleMutationResult = {
  id: string;
  title: string;
  updatedAt: string;
};

export type SessionPhaseMutationResult = {
  artifactVersion: number;
  currentStageId: string;
  id: string;
  phaseStatus: SessionPhaseStatus;
  updatedAt: string;
};
