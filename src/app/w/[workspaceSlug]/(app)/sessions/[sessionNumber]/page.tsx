import { Suspense } from "react";

import { MarkdownContent } from "@/components/shared/markdown-content";
import {
  SessionActivity,
  SessionActivityFallback,
} from "@/features/sessions/detail/session-activity";
import { loadSessionDetailPageData } from "@/features/sessions/detail/data";
import { SessionDetailPageClient } from "@/features/sessions/detail/session-detail-page-client";

type SessionDetailPageProps = {
  params: Promise<{
    sessionNumber: string;
    workspaceSlug: string;
  }>;
};

export default async function SessionDetailPage({ params }: SessionDetailPageProps) {
  const { sessionNumber, workspaceSlug } = await params;
  const data = await loadSessionDetailPageData(workspaceSlug, sessionNumber);
  const initialNow = new Date().toISOString();
  const latestArtifact = data.review.session.artifacts[0] ?? null;
  const initialFormattedArtifactKey = latestArtifact
    ? `${data.review.session.id}:${latestArtifact.stageSlug}:${latestArtifact.version}`
    : null;
  const initialFormattedArtifact =
    latestArtifact && typeof latestArtifact.payload === "string" ? (
      <MarkdownContent className="max-h-[480px] overflow-auto">
        {latestArtifact.payload}
      </MarkdownContent>
    ) : null;

  return (
    <SessionDetailPageClient
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
      initialData={data.review}
      initialNow={initialNow}
      initialFormattedArtifact={initialFormattedArtifact}
      initialFormattedArtifactKey={initialFormattedArtifactKey}
    />
  );
}
