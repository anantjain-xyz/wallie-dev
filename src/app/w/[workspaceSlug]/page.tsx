import { redirect } from "next/navigation";

import { workspaceIssuesPath } from "@/lib/routes";

type WorkspaceIndexPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceIndexPage({ params }: WorkspaceIndexPageProps) {
  const { workspaceSlug } = await params;

  redirect(workspaceIssuesPath(workspaceSlug));
}
