import { loadPipelineDashboardData } from "@/features/pipeline/data";
import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";

type PipelinePageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function PipelinePage({ params }: PipelinePageProps) {
  const { workspaceSlug } = await params;
  const data = await loadPipelineDashboardData(workspaceSlug);

  return <PipelinePageClient initialData={data} />;
}
