import { loadSessionListPageData } from "@/features/sessions/list/data";
import { SessionsPageClient } from "@/features/sessions/list/sessions-page-client";

type SessionsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SessionsPage({ params, searchParams }: SessionsPageProps) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const data = await loadSessionListPageData(workspaceSlug, resolvedSearchParams);
  const initialNow = new Date().toISOString();

  return <SessionsPageClient initialData={data} initialNow={initialNow} />;
}
