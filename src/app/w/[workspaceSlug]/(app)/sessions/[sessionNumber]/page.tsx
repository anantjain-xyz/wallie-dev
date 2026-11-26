import { Suspense } from "react";
import { notFound } from "next/navigation";

import { MarkdownContent } from "@/components/shared/markdown-content";
import {
  mayContainEvidenceLinks,
  renderMarkdown,
} from "@/components/shared/markdown-content.server";
import {
  SessionActivity,
  SessionActivityFallback,
} from "@/features/sessions/detail/session-activity";
import { loadSessionDetailPageData } from "@/features/sessions/detail/data";
import { SessionDetailPageClient } from "@/features/sessions/detail/session-detail-page-client";
import { parseSessionBrowseReturn } from "@/lib/sessions/browse-return";
import {
  parseSessionReviewTarget,
  sessionReviewQuery,
  type ExactSessionReviewTarget,
  type RequestedSessionReviewTarget,
} from "@/lib/sessions/review-link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadArtifactEvidenceLinks } from "@/lib/validation-evidence/artifact-links";

type SessionDetailPageProps = {
  params: Promise<{
    sessionNumber: string;
    workspaceSlug: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

async function loadExactReview(
  data: Awaited<ReturnType<typeof loadSessionDetailPageData>>,
  requested: RequestedSessionReviewTarget,
) {
  const supabase = await createSupabaseServerClient();
  const { workspaceId, sessionId } = data.activityContext;
  let lookup = supabase
    .from("session_artifacts")
    .select("id, stage_id, stage_slug, version, artifact_json, created_at")
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .eq("id", requested.artifactId)
    .eq("stage_slug", requested.stageSlug)
    .eq("version", requested.artifactVersion);
  if (requested.stageId) lookup = lookup.eq("stage_id", requested.stageId);
  const { data: artifact, error } = await lookup.maybeSingle();
  if (error) throw new Error("Could not read the exact review artifact.");
  if (!artifact?.stage_id) notFound();

  if (requested.clarificationId) {
    const { data: question, error: questionError } = await supabase
      .from("session_specification_clarifications")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("session_id", sessionId)
      .eq("stage_id", artifact.stage_id)
      .eq("artifact_id", artifact.id)
      .eq("artifact_version", artifact.version)
      .eq("id", requested.clarificationId)
      .maybeSingle();
    if (questionError) throw new Error("Could not read the exact clarification.");
    if (!question) notFound();
  }

  const target: ExactSessionReviewTarget = { ...requested, stageId: artifact.stage_id };
  return {
    target,
    artifact: {
      id: artifact.id,
      stageSlug: artifact.stage_slug,
      version: artifact.version,
      payload: artifact.artifact_json,
      createdAt: artifact.created_at,
    },
  };
}

export default async function SessionDetailPage({ params, searchParams }: SessionDetailPageProps) {
  const { sessionNumber, workspaceSlug } = await params;
  const query = (await searchParams) ?? {};
  const browseReturn = parseSessionBrowseReturn(workspaceSlug, query.returnTo);
  const request = parseSessionReviewTarget(query);
  if (request.kind === "invalid") notFound();
  const data =
    request.kind === "exact"
      ? await loadSessionDetailPageData(workspaceSlug, sessionNumber, {
          ...sessionReviewQuery(request.target),
          returnTo: browseReturn?.href,
        })
      : await loadSessionDetailPageData(
          workspaceSlug,
          sessionNumber,
          browseReturn ? { returnTo: browseReturn.href } : undefined,
        );
  const exactReview = request.kind === "exact" ? await loadExactReview(data, request.target) : null;
  const initialNow = new Date().toISOString();
  const latestArtifact =
    exactReview?.artifact ??
    data.review.session.artifacts.find(
      (artifact) => artifact.id === data.review.session.currentArtifactId,
    ) ??
    null;
  const initialFormattedArtifactKey = latestArtifact
    ? `${data.review.session.id}:${latestArtifact.stageSlug}:${latestArtifact.id ? `id:${latestArtifact.id}` : latestArtifact.version}`
    : null;
  const evidenceLinks =
    latestArtifact?.id &&
    typeof latestArtifact.payload === "string" &&
    mayContainEvidenceLinks(latestArtifact.payload)
      ? await loadArtifactEvidenceLinks({
          supabase: await createSupabaseServerClient(),
          ...data.activityContext,
          artifactId: latestArtifact.id,
        })
      : undefined;
  const initialFormattedArtifact =
    latestArtifact && typeof latestArtifact.payload === "string" ? (
      <MarkdownContent
        html={renderMarkdown(latestArtifact.payload, true, evidenceLinks).bodyHtml}
      />
    ) : null;

  return (
    <SessionDetailPageClient
      browseReturn={browseReturn}
      activity={
        <Suspense fallback={<SessionActivityFallback />}>
          <SessionActivity
            archivedAt={data.review.session.archivedAt}
            context={data.activityContext}
            initialNow={initialNow}
            workspaceSlug={data.review.workspaceSlug}
          />
        </Suspense>
      }
      canReview={data.canReview}
      failedStageSlug={data.failedStageSlug}
      hasFailedRun={data.hasFailedRun}
      latestRun={data.latestRun}
      initialData={data.review}
      initialNow={initialNow}
      initialFormattedArtifact={initialFormattedArtifact}
      initialFormattedArtifactKey={initialFormattedArtifactKey}
      initialExactReviewTarget={exactReview?.target}
      repository={data.repository}
      workflowInspection={data.workflowInspection ?? undefined}
    />
  );
}
