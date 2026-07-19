import type { PipelinePhaseStatus } from "@/lib/pipeline/types";

// Sessions used to be pinned to a hardcoded phase enum. They now reference a
// workspace's pipeline by id and advance through pipeline_stages by `position`.
// Stages are user-editable in settings; the seeded default is the
// Symphony-inspired plan → build → review → land shape.

export type SessionPhaseStatus = PipelinePhaseStatus;

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
  operatingRulesMd: string;
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

export type SessionRepositoryOption = {
  fullName: string;
  id: string;
};

export type SessionPhaseCompletion = {
  completedAt: string;
  id?: string;
  stageSlug: string;
};

export type SessionArtifactSummary = {
  createdAt: string;
  id?: string;
  payload: unknown;
  stageSlug: string;
  version: number;
};

export type SessionArtifactMetadata = Omit<SessionArtifactSummary, "payload"> & {
  /** Attempt number within the stage (same as version for that stage). */
  attempt: number;
  /** Display label for the producing agent or author. */
  authorLabel: string;
  /** True when this version received rejection feedback. */
  changesRequested: boolean;
};

export type SessionArtifactBody = SessionArtifactSummary & {
  /** Sanitized server-rendered markup for Markdown payloads; null for structured payloads. */
  sanitizedHtml: string | null;
};

export type SessionSummary = {
  archivedAt: string | null;
  createdAt: string;
  currentArtifactVersion: number | null;
  currentStageId: string;
  currentStageName: string;
  currentStagePosition: number;
  currentStageSlug: string;
  id: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  phaseStatus: SessionPhaseStatus;
  pipelineId: string;
  promptMd: string;
  pullRequestCount: number;
  pullRequests: SessionPullRequest[];
  rejectionCount: number;
  /** Resolved from the session's pinned GitHub repository when present. */
  repositoryFullName: string | null;
  title: string;
  updatedAt: string;
  workspaceId: string;
};

export type SessionListItem = Omit<SessionSummary, "promptMd">;

export type SessionDetail = SessionSummary & {
  artifacts: SessionArtifactSummary[];
  phaseCompletions: SessionPhaseCompletion[];
  pipeline: SessionPipeline;
  pullRequests: SessionPullRequest[];
};

export type SessionFilterKey = "all" | "active" | "archived" | "has-pr";

/** URL-backed Sessions ledger sort. Default (`updated`) is omitted from the query string. */
export type SessionListSortKey = "updated" | "oldest" | "number";

export type SessionListQueryState = {
  cursor: string | null;
  query: string;
  scope: SessionFilterKey;
  sort: SessionListSortKey;
  stageSlug: string | null;
};

export function stageIndex(pipeline: SessionPipeline, stageSlug: string): number {
  return pipeline.stages.findIndex((s) => s.slug === stageSlug);
}

export function isTerminalStage(pipeline: SessionPipeline, stageSlug: string): boolean {
  if (pipeline.stages.length === 0) return false;
  return pipeline.stages[pipeline.stages.length - 1]!.slug === stageSlug;
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
