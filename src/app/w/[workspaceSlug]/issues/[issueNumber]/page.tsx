import { IssueDetailPageClient } from "@/features/issues/detail/issue-detail-page-client";
import { loadIssueDetailPageData } from "@/features/issues/detail/data";

type IssueDetailPageProps = {
  params: Promise<{
    issueNumber: string;
    workspaceSlug: string;
  }>;
};

export default async function IssueDetailPage({
  params,
}: IssueDetailPageProps) {
  const { issueNumber, workspaceSlug } = await params;
  const data = await loadIssueDetailPageData(workspaceSlug, issueNumber);

  return <IssueDetailPageClient initialData={data} />;
}
