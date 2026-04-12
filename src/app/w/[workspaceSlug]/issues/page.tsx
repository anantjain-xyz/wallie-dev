import { redirect } from "next/navigation";

import { workspaceSessionsPath } from "@/lib/routes";

type IssuesLegacyPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function IssuesLegacyPage({ params, searchParams }: IssuesLegacyPageProps) {
  const { workspaceSlug } = await params;
  const resolved = await searchParams;
  const query: Record<string, string> = {};
  if (typeof resolved.q === "string") query.q = resolved.q;
  if (typeof resolved.create === "string") query.create = resolved.create;
  redirect(workspaceSessionsPath(workspaceSlug, query));
}
