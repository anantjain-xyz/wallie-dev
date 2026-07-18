import { loadPipelineDashboardData } from "@/features/pipeline/data";
import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";

type WorkspaceHomePageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceHomePage({ params }: WorkspaceHomePageProps) {
  const { workspaceSlug } = await params;
  const data = await loadPipelineDashboardData(workspaceSlug);
  const initialNow = new Date().toISOString();

  return <PipelinePageClient initialData={data} initialNow={initialNow} />;
}
