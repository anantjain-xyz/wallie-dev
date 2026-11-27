import type { OnboardingResumeState } from "@/features/onboarding/flow";
import type { SessionBrowseFactory } from "@/features/sessions/browse-pipeline-owners";
import type { SessionPhaseStatus, SessionPullRequest } from "@/features/sessions/types";
import type { Enums } from "@/lib/supabase/database.types";

export const PIPELINE_DASHBOARD_PAGE_SIZE = 25;
export const PIPELINE_SEARCH_MAX_LENGTH = 200;
export const PIPELINE_STATUS_FILTERS = [
  "all",
  "awaiting_review",
  "in_progress",
  "approved",
  "rejected",
  "failed",
] as const;
export type PipelineStatusFilter = (typeof PIPELINE_STATUS_FILTERS)[number];
export type PipelineDashboardFilters = { query: string; status: PipelineStatusFilter };

export type PipelineDashboardPullRequest = Pick<
  SessionPullRequest,
  "id" | "pullRequestNumber" | "pullRequestUrl"
>;

export type PipelineDashboardCard = {
  createdAt: string;
  currentStageId: string;
  id: string;
  latestRunId: string | null;
  latestRunStatus: Enums<"agent_run_status"> | null;
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
  activeCount?: number;
  cards: PipelineDashboardCard[];
  cursor: string | null;
  description: string;
  factory?: SessionBrowseFactory;
  factoryName?: string;
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
  creationFactoryName?: string;
  aggregateFactories?: boolean;
  overviewFactories?: SessionBrowseFactory[];
  factoryId?: string;
  showCreationOnboarding?: boolean;
  hasAnySession: boolean;
  lanes: PipelineDashboardLane[];
  onboarding: OnboardingResumeState | null;
  workspace: { id: string; name: string; slug: string };
};

export type PipelineDashboardLanePage = Pick<
  PipelineDashboardLane,
  "cards" | "cursor" | "id" | "pipeline" | "totalCount"
>;
