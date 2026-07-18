import type { OnboardingResumeState } from "@/features/onboarding/flow";
import type { SessionPhaseStatus, SessionPullRequest } from "@/features/sessions/types";

export const PIPELINE_DASHBOARD_PAGE_SIZE = 25;

export type PipelineDashboardPullRequest = Pick<
  SessionPullRequest,
  "id" | "pullRequestNumber" | "pullRequestUrl"
>;

export type PipelineDashboardCard = {
  createdAt: string;
  currentStageId: string;
  id: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  phaseStatus: SessionPhaseStatus;
  pipelineId: string;
  pullRequests: PipelineDashboardPullRequest[];
  rejectionCount: number;
  title: string;
  updatedAt: string;
  workspaceId: string;
};

export type PipelineDashboardLane = {
  cards: PipelineDashboardCard[];
  cursor: string | null;
  description: string;
  id: string;
  name: string;
  pipeline: {
    id: string;
    isDefault: boolean;
    name: string;
  };
  position: number;
  slug: string;
  totalCount: number;
};

export type PipelineBoardLane = Omit<PipelineDashboardLane, "cards"> & {
  cardIds: string[];
};

export type PipelineBoardState = {
  cardsById: Record<string, PipelineDashboardCard>;
  lanes: PipelineBoardLane[];
  offPageCardLaneKeys: Record<string, string>;
};

export type PipelineDashboardData = {
  lanes: PipelineDashboardLane[];
  onboarding: OnboardingResumeState | null;
  workspace: { id: string; name: string; slug: string };
};

export type PipelineDashboardLanePage = Pick<
  PipelineDashboardLane,
  "cards" | "cursor" | "id" | "pipeline" | "totalCount"
>;
