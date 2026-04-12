import type { PipelinePhaseStatus } from "@/lib/pipeline/types";

// The 6-phase model targeted by the refactor. PR 1 expands the DB enum to
// match; the UI hard-codes this order because it's the load-bearing product
// surface and we want the phase rail to render all six even before the DB
// catches up.
export type SessionPhase =
  | "product"
  | "design"
  | "engineering"
  | "review"
  | "land"
  | "monitor";

export const SESSION_PHASE_ORDER = [
  "product",
  "design",
  "engineering",
  "review",
  "land",
  "monitor",
] as const satisfies readonly SessionPhase[];

export const SESSION_PHASE_LABELS: Record<SessionPhase, string> = {
  product: "Product",
  design: "Design",
  engineering: "Engineering",
  review: "Review",
  land: "Land",
  monitor: "Monitor",
};

export const SESSION_PHASE_DESCRIPTIONS: Record<SessionPhase, string> = {
  product: "Write the spec and approve the problem framing.",
  design: "Resolve the design approach before engineering picks it up.",
  engineering: "Scope the implementation plan and confirm the diff shape.",
  review: "Human review of the generated change set.",
  land: "Merge, tag, and roll out.",
  monitor: "Watch for regressions. Terminal phase — approving archives.",
};

export type SessionPhaseStatus = PipelinePhaseStatus;

export const SESSION_PHASE_STATUS_LABELS: Record<SessionPhaseStatus, string> = {
  agent_generating: "drafting",
  awaiting_review: "awaiting review",
  approved: "approved",
  rejected: "rejected",
  escalated: "escalated",
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
  phase: SessionPhase;
};

export type SessionArtifactSummary = {
  createdAt: string;
  phase: SessionPhase;
  payload: unknown;
  version: number;
};

export type SessionSummary = {
  archivedAt: string | null;
  createdAt: string;
  currentArtifactVersion: number | null;
  id: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  phase: SessionPhase;
  phaseStatus: SessionPhaseStatus;
  promptMd: string;
  pullRequestCount: number;
  rejectionCount: number;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  title: string;
  updatedAt: string;
  workspaceId: string;
};

export type SessionDetail = SessionSummary & {
  artifacts: SessionArtifactSummary[];
  phaseCompletions: SessionPhaseCompletion[];
  pullRequests: SessionPullRequest[];
  runHistory: SessionRun[];
};

export type SessionRun = {
  createdAt: string;
  finishedAt: string | null;
  id: string;
  modelName: string;
  runType: string;
  startedAt: string | null;
  status: string;
};

export type SessionFilterKey = "all" | "active" | "archived" | "has-pr";

export type SessionListQueryState = {
  phase: SessionPhase | null;
  query: string;
  scope: SessionFilterKey;
};

export function sessionPhaseIndex(phase: SessionPhase): number {
  return SESSION_PHASE_ORDER.indexOf(phase);
}

export function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "monitor";
}

export function sessionPhaseStatusTone(
  status: SessionPhaseStatus,
): "blocked" | "planned" | "ready" {
  if (status === "approved") return "ready";
  if (status === "rejected" || status === "escalated") return "blocked";
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
