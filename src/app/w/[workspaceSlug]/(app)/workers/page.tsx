import { loadWorkerHealthPageData } from "@/features/workers/data";
import { WorkerHealthPageClient } from "@/features/workers/workers-page-client";

type WorkerHealthPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkerHealthPage({ params }: WorkerHealthPageProps) {
  const { workspaceSlug } = await params;
  const data = await loadWorkerHealthPageData(workspaceSlug);

  return <WorkerHealthPageClient initialData={data} />;
}
