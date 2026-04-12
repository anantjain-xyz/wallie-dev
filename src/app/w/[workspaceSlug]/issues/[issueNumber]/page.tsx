import { redirect } from "next/navigation";

import { workspaceSessionDetailPath } from "@/lib/routes";

type IssueDetailLegacyPageProps = {
  params: Promise<{
    issueNumber: string;
    workspaceSlug: string;
  }>;
};

export default async function IssueDetailLegacyPage({ params }: IssueDetailLegacyPageProps) {
  const { issueNumber, workspaceSlug } = await params;
  redirect(workspaceSessionDetailPath(workspaceSlug, issueNumber));
}
