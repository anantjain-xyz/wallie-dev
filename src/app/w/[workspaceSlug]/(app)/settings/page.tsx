import { SettingsPageClient } from "@/features/settings/settings-page-client";
import { loadSettingsPageData } from "@/features/settings/data";

type SettingsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<{
    github?: string;
    codex_connect?: string;
  }>;
};

export default async function SettingsPage({ params, searchParams }: SettingsPageProps) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const data = await loadSettingsPageData(workspaceSlug);
  const initialData = await data.initialData;

  return (
    <SettingsPageClient
      initialData={initialData}
      searchState={{
        githubStatus: resolvedSearchParams.github ?? null,
        codexStatus: resolvedSearchParams.codex_connect ?? null,
      }}
      setupData={data.setupData}
      usage={data.usage}
      workspaceInvitations={data.workspaceInvitations}
    />
  );
}
