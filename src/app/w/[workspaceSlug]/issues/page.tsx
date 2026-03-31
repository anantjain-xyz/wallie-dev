import { IssuesPageClient } from "@/features/issues/list/issues-page-client";
import { loadIssueListPageData } from "@/features/issues/list/data";

type IssuesPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function IssuesPage({
  params,
  searchParams,
}: IssuesPageProps) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const data = await loadIssueListPageData(workspaceSlug, resolvedSearchParams);

  return <IssuesPageClient initialData={data} />;
}
