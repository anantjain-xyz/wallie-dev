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

  return <SessionDetailPageClient initialData={data} />;
}
