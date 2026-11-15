import { RunsList } from "@/features/wallie/runs-list";
import { loadRunsListData } from "@/features/wallie/runs-list-data";
import type { RunsListSearchParams } from "@/features/wallie/runs-list-state";

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<RunsListSearchParams>;
}) {
  const { workspaceSlug } = await params;
  const data = await loadRunsListData(workspaceSlug, await searchParams);
  return <RunsList data={data} initialNow={new Date().toISOString()} />;
}
