import type { SessionActivityContext, SessionReviewData, SessionReviewSession } from "./data";

export type SessionDetailRpcPayload = {
  activity: SessionActivityContext;
  creatorDisplayName: string | null;
  session: Omit<SessionReviewSession, "attachments">;
  workspaceSlug: string;
};

export type SessionAttachmentRpcRow = {
  attachment_position: number;
  content_type: string;
  id: string;
  original_filename: string;
  size_bytes: number;
};

/**
 * Build every client-bound object explicitly.This deliberately avoids row or
 * RPC payload spreads so a database field cannot silently re-expand the RSC
 * contract.
 */
export function serializeSessionReviewData(
  payload: SessionDetailRpcPayload,
  attachments: SessionAttachmentRpcRow[] = [],
): SessionReviewData {
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
      attachments: attachments.map((attachment) => ({
        contentType: attachment.content_type,
        fileName: attachment.original_filename,
        id: attachment.id,
        position: attachment.attachment_position,
        sizeBytes: attachment.size_bytes,
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
        id: completion.id,
        stageId: completion.stageId,
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
