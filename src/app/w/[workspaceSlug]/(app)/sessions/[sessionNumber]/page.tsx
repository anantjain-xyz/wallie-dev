import { MarkdownContent } from "@/components/shared/markdown-content";
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
  const latestArtifact = data.session.artifacts[0] ?? null;
  const initialFormattedArtifactKey = latestArtifact
    ? `${data.session.id}:${latestArtifact.stageSlug}:${latestArtifact.version}`
    : null;
  const initialFormattedArtifact =
    latestArtifact && typeof latestArtifact.payload === "string" ? (
      <MarkdownContent className="max-h-[480px] overflow-auto">
        {latestArtifact.payload}
      </MarkdownContent>
    ) : null;

  return (
    <SessionDetailPageClient
      initialData={data}
      initialFormattedArtifact={initialFormattedArtifact}
      initialFormattedArtifactKey={initialFormattedArtifactKey}
    />
  );
}
