import "server-only";

import { notFound, redirect } from "next/navigation";

import type { SessionConnectionPullRequest } from "@/features/sessions/components/session-connections";
import type {
  SessionArtifactSummary,
  SessionPhaseCompletion,
  SessionPhaseStatus,
} from "@/features/sessions/types";
import type { WallieSessionRepository } from "@/features/wallie/types";
import { loginPath, onboardingWorkspacePath, workspaceSessionDetailPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  approximatePayloadSizeBytes,
  type ServerTimingCollector,
  withServerTiming,
} from "@/lib/server-timing";
import { loadSessionReviewCapabilities } from "@/features/sessions/detail/review-capabilities";

/**
 * Seeded session #18 was 10,603 bytes at the detail RPC before member and
 * activity data were added to the client boundary. Keep the critical review
 * contract below 4.5 KiB on that seed (a 57% reduction from the RPC alone).
 */
export const SESSION_REVIEW_PAYLOAD_TARGET_BYTES = 4_500;

export type SessionReviewStage = {
  description: string;
  id: string;
  name: string;
  position: number;
  slug: string;
};

export type SessionReviewPipeline = {
  stages: SessionReviewStage[];
};

export type SessionReviewSession = {
  archivedAt: string | null;
  artifacts: SessionArtifactSummary[];
  createdAt: string;
  currentArtifactVersion: number | null;
  currentStageId: string;
  currentStageSlug: string;
  id: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  phaseCompletions: SessionPhaseCompletion[];
  phaseStatus: SessionPhaseStatus;
  pipeline: SessionReviewPipeline;
  promptMd: string;
  pullRequests: SessionConnectionPullRequest[];
  /** Client-only reconciliation metadata populated by mutation/realtime responses. */
  rejectionCount?: number;
  title: string;
  updatedAt: string;
};

/** The only session-detail data serialized into the critical client surface. */
export type SessionReviewData = {
  creatorDisplayName: string | null;
  session: SessionReviewSession;
  workspaceSlug: string;
};

export type SessionActivityContext = {
  repository: WallieSessionRepository | null;
  sessionGithubRepositoryId: string | null;
  sessionId: string;
  workspaceId: string;
};

export type SessionReviewRepository = {
  defaultBranch: string | null;
  fullName: string;
  htmlUrl: string;
};

export type SessionDetailPageData = {
  activityContext: SessionActivityContext;
  canReview: boolean;
  failedStageSlug: string | null;
  hasFailedRun: boolean;
  repository: SessionReviewRepository | null;
  review: SessionReviewData;
};

type SessionDetailRpcPayload = {
  activity: SessionActivityContext;
  creatorDisplayName: string | null;
  session: SessionReviewSession;
  workspaceSlug: string;
};

type SessionDetailRpcAccessMiss = {
  access: {
    hasAnyWorkspace: boolean;
  };
};

type SessionDetailRpcResult = SessionDetailRpcAccessMiss | SessionDetailRpcPayload;

export async function loadSessionDetailPageData(
  workspaceSlug: string,
  sessionNumberValue: string,
): Promise<SessionDetailPageData> {
  const sessionNumber = Number(sessionNumberValue);
  if (!Number.isInteger(sessionNumber) || sessionNumber < 1) {
    notFound();
  }

  return withServerTiming(
    "sessions.detail.review",
    {
      sessionNumber,
      workspaceSlug,
    },
    (timing) => loadSessionDetailPageDataWithTiming(workspaceSlug, sessionNumber, timing),
  );
}

async function loadSessionDetailPageDataWithTiming(
  workspaceSlug: string,
  sessionNumber: number,
  timing: ServerTimingCollector,
): Promise<SessionDetailPageData> {
  const supabase = await createSupabaseServerClient();
  const [user, { data: rpcData, error: rpcError }] = await Promise.all([
    timing.segment(
      "auth.get-user",
      () => getSupabaseUserOrNull(supabase),
      (resolvedUser) => ({ rows: resolvedUser ? 1 : 0 }),
    ),
    timing.segment(
      "session-detail-rpc",
      () =>
        supabase.rpc("get_session_detail_page", {
          target_session_number: sessionNumber,
          target_workspace_slug: workspaceSlug,
        }),
      (result) => ({
        payloadBytes: approximatePayloadSizeBytes(result.data),
        rows: result.data ? 1 : 0,
      }),
    ),
  ]);

  if (!user) {
    redirect(loginPath(workspaceSessionDetailPath(workspaceSlug, sessionNumber)));
  }

  if (rpcError) throw rpcError;
  if (!rpcData) notFound();

  const payload = rpcData as SessionDetailRpcResult;
  if ("access" in payload) {
    if (!payload.access.hasAnyWorkspace) {
      redirect(onboardingWorkspacePath());
    }

    notFound();
  }

  if (!payload.session || !payload.activity) notFound();

  const review = serializeSessionReviewData(payload);
  const repository = serializeSessionReviewRepository(payload.activity.repository);
  const capabilities = await timing.segment("review.authorization", () =>
    loadSessionReviewCapabilities({
      memberUserId: user.id,
      sessionId: payload.session.id,
      stageId: payload.session.currentStageId,
      supabase,
      workspaceId: payload.activity.workspaceId,
    }),
  );

  await timing.segment("review-contract", () => review, {
    payloadBytes: approximatePayloadSizeBytes(review),
    targetBytes: SESSION_REVIEW_PAYLOAD_TARGET_BYTES,
  });

  return {
    activityContext: {
      repository: payload.activity.repository,
      sessionGithubRepositoryId: payload.activity.sessionGithubRepositoryId,
      sessionId: payload.activity.sessionId,
      workspaceId: payload.activity.workspaceId,
    },
    canReview: capabilities.canApprove,
    failedStageSlug: capabilities.failedStageSlug,
    hasFailedRun: capabilities.hasFailedRun,
    repository,
    review,
  };
}

export function serializeSessionReviewRepository(
  repository: WallieSessionRepository | null,
): SessionReviewRepository | null {
  if (!repository) return null;
  return {
    defaultBranch: repository.defaultBranch,
    fullName: repository.fullName,
    htmlUrl: repository.htmlUrl,
  };
}

/**
 * Build every client-bound object explicitly. This deliberately avoids row or
 * RPC payload spreads so a database field cannot silently re-expand the RSC
 * contract.
 */
export function serializeSessionReviewData(payload: SessionDetailRpcPayload): SessionReviewData {
  return {
    creatorDisplayName: payload.creatorDisplayName,
    session: {
      archivedAt: payload.session.archivedAt,
      artifacts: payload.session.artifacts.map((artifact) => ({
        createdAt: artifact.createdAt,
        payload: artifact.payload,
        stageSlug: artifact.stageSlug,
        version: artifact.version,
      })),
      createdAt: payload.session.createdAt,
      currentArtifactVersion: payload.session.currentArtifactVersion,
      currentStageId: payload.session.currentStageId,
      currentStageSlug: payload.session.currentStageSlug,
      id: payload.session.id,
      linearIssueId: payload.session.linearIssueId,
      linearIssueUrl: payload.session.linearIssueUrl,
      number: payload.session.number,
      phaseCompletions: payload.session.phaseCompletions.map((completion) => ({
        completedAt: completion.completedAt,
        stageSlug: completion.stageSlug,
      })),
      phaseStatus: payload.session.phaseStatus,
      pipeline: {
        stages: payload.session.pipeline.stages.map((stage) => ({
          description: stage.description,
          id: stage.id,
          name: stage.name,
          position: stage.position,
          slug: stage.slug,
        })),
      },
      promptMd: payload.session.promptMd,
      pullRequests: payload.session.pullRequests.map((pullRequest) => ({
        id: pullRequest.id,
        pullRequestNumber: pullRequest.pullRequestNumber,
        pullRequestUrl: pullRequest.pullRequestUrl,
      })),
      title: payload.session.title,
      updatedAt: payload.session.updatedAt,
    },
    workspaceSlug: payload.workspaceSlug,
  };
}
