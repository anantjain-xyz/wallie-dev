import { SettingsPageClient } from "@/features/settings/settings-page-client";
import { loadSettingsPageData } from "@/features/settings/data";

type SettingsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<{
    billing?: string;
    github?: string;
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
        billingStatus: resolvedSearchParams.billing ?? null,
        githubStatus: resolvedSearchParams.github ?? null,
      }}
    />
  );
}
