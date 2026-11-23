import { Suspense } from "react";
import { z } from "zod";

import { AutomationPreviewLink } from "@/features/settings/automation-preview-link";
import { PersonalOAuthConnections } from "@/features/settings/personal-oauth-connections";
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
    afterOAuthGrant?: string | string[];
  }>;
};

export default async function SettingsPage({ params, searchParams }: SettingsPageProps) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const category = parseSettingsCategory(resolvedSearchParams.category);
  const data = await loadSettingsPageData(workspaceSlug, category);
  const afterOAuthGrant = z.string().uuid().safeParse(resolvedSearchParams.afterOAuthGrant).data;
  const initialData = await data.initialData;

  return (
    <SettingsServerShell
      automationPreview={
        category === "integrations" ? (
          <Suspense fallback={null}>
            <AutomationPreviewLink workspaceSlug={workspaceSlug} />
          </Suspense>
        ) : undefined
      }
      category={category}
      initialData={initialData}
      personalConnections={
        category === "workspace" ? (
          <PersonalOAuthConnections
            afterOAuthGrant={afterOAuthGrant}
            workspaceSlug={workspaceSlug}
          />
        ) : undefined
      }
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
