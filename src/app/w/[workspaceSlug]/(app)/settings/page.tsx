import { SettingsPageClient } from "@/features/settings/settings-page-client";
import { loadSettingsPageData } from "@/features/settings/data";

type SettingsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<{
    github?: string;
    github_author?: string;
    codex_connect?: string;
  }>;
};

export default async function SettingsPage({ params, searchParams }: SettingsPageProps) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const data = await loadSettingsPageData(workspaceSlug);

  return (
    <SettingsPageClient
      initialData={data}
      searchState={{
        githubStatus: resolvedSearchParams.github ?? null,
        githubAuthorStatus: resolvedSearchParams.github_author ?? null,
        codexStatus: resolvedSearchParams.codex_connect ?? null,
      }}
    />
  );
}
