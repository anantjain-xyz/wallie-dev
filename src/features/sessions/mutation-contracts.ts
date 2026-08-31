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

export type SessionMutationStage = {
  description: string;
  id: string;
  name: string;
  position: number;
  slug: string;
};

export type SessionPhaseMutationResult = {
  archivedAt: string | null;
  artifactVersion: number;
  currentStageId: string;
  currentStage: SessionMutationStage;
  id: string;
  phaseStatus: SessionPhaseStatus;
  rejectionCount: number;
  updatedAt: string;
};
