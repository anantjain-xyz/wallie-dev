import type { PipelinePhaseStatus } from "@/lib/pipeline/types";

// Sessions used to be pinned to a hardcoded 6-phase enum (product → design →
// engineering → review → land → monitor). They now reference a workspace's
// pipeline by id and advance through pipeline_stages by `position`. Stages
// are user-editable in settings; the 6-phase shape is the seeded default.

export type SessionPhaseStatus = PipelinePhaseStatus;

export const SESSION_PHASE_STATUS_LABELS: Record<SessionPhaseStatus, string> = {
  agent_generating: "drafting",
  awaiting_review: "awaiting review",
  approved: "approved",
  rejected: "rejected",
};

export type PipelineStage = {
  approverMemberIds: string[];
  description: string;
  id: string;
  name: string;
  pipelineId: string;
  position: number;
  promptTemplateMd: string;
  slug: string;
};

export type SessionPipeline = {
  id: string;
  isDefault: boolean;
  name: string;
  stages: PipelineStage[];
};

export type SessionPullRequest = {
  branchName: string;
  id: string;
  isDraft: boolean | null;
  pullRequestNumber: number | null;
  pullRequestState: string | null;
  pullRequestUrl: string | null;
  repositoryFullName: string | null;
  repositoryHtmlUrl: string | null;
  updatedAt: string;
};

export type SessionPhaseCompletion = {
  completedAt: string;
  stageSlug: string;
};

export type SessionArtifactSummary = {
  createdAt: string;
  payload: unknown;
  stageSlug: string;
  version: number;
};

export type SessionSummary = {
  archivedAt: string | null;
  createdAt: string;
  currentArtifactVersion: number | null;
  currentStageId: string;
  currentStageName: string;
  currentStageSlug: string;
  id: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  phaseStatus: SessionPhaseStatus;
  pipelineId: string;
  promptMd: string;
  pullRequestCount: number;
  rejectionCount: number;
  title: string;
  updatedAt: string;
  workspaceId: string;
};

export type SessionDetail = SessionSummary & {
  artifacts: SessionArtifactSummary[];
  phaseCompletions: SessionPhaseCompletion[];
  pipeline: SessionPipeline;
  pullRequests: SessionPullRequest[];
  runHistory: SessionRun[];
};

export type SessionRun = {
  createdAt: string;
  finishedAt: string | null;
  id: string;
  inputTokens: number | null;
  modelName: string;
  outputTokens: number | null;
  runType: string;
  startedAt: string | null;
  status: string;
  totalCostUsd: number | null;
};

export type SessionFilterKey = "all" | "active" | "archived" | "has-pr";

export type SessionListQueryState = {
  query: string;
  scope: SessionFilterKey;
  stageSlug: string | null;
};

export function stageIndex(pipeline: SessionPipeline, stageSlug: string): number {
  return pipeline.stages.findIndex((s) => s.slug === stageSlug);
}

export function isTerminalStage(pipeline: SessionPipeline, stageSlug: string): boolean {
  if (pipeline.stages.length === 0) return false;
  return pipeline.stages[pipeline.stages.length - 1]!.slug === stageSlug;
}

export function sessionPhaseStatusTone(
  status: SessionPhaseStatus,
): "blocked" | "planned" | "ready" {
  if (status === "approved") return "ready";
  if (status === "rejected") return "blocked";
  return "planned";
}

export function formatSessionPhaseStatus(status: SessionPhaseStatus): string {
  return SESSION_PHASE_STATUS_LABELS[status];
}

export function deriveSessionTitleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return "Untitled session";
  }

  const cleaned = firstLine.replace(/^#+\s*/, "").trim();
  if (cleaned.length <= 80) {
    return cleaned || "Untitled session";
  }

  return `${cleaned.slice(0, 77).trimEnd()}…`;
}
