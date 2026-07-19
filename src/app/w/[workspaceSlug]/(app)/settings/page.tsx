import { loadSettingsPageData } from "@/features/settings/data";
import { parseSettingsCategory } from "@/features/settings/settings-categories";
import { SettingsServerShell } from "@/features/settings/settings-server-shell";

type SettingsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<{
    github?: string;
    codex_connect?: string;
    category?: string | string[];
  }>;
};

export default async function SettingsPage({ params, searchParams }: SettingsPageProps) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const category = parseSettingsCategory(resolvedSearchParams.category);
  const data = await loadSettingsPageData(workspaceSlug, category);
  const initialData = await data.initialData;

  return (
    <SettingsServerShell
      category={category}
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
