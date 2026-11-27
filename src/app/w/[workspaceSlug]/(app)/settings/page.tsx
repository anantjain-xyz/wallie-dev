import { Suspense } from "react";
import { z } from "zod";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { AutomationPreviewLink } from "@/features/settings/automation-preview-link";
import { ConnectorSettingsSection } from "@/features/settings/connector-settings/section";
import { PersonalOAuthConnections } from "@/features/settings/personal-oauth-connections";
import { loadSettingsPageData } from "@/features/settings/data";
import { parseSettingsCategory } from "@/features/settings/settings-categories";
import {
  SettingsSectionFallback,
  SettingsServerShell,
} from "@/features/settings/settings-server-shell";

type SettingsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<{
    github?: string;
    codex_connect?: string;
    category?: string | string[];
    factory?: string | string[];
    afterOAuthGrant?: string | string[];
    oauthView?: string | string[];
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
      connectorSettings={
        category === "integrations" ? (
          <Suspense fallback={<SettingsSectionFallback label="connector resources" />}>
            <ConnectorSettingsSection
              requestedFactory={resolvedSearchParams.factory}
              workspaceId={initialData.workspace.id}
              workspaceSlug={workspaceSlug}
            />
          </Suspense>
        ) : undefined
      }
      defaultFactoryName={
        category === "integrations"
          ? loadWorkspaceFactoryOptions(workspaceSlug)
              .then(
                (factories) =>
                  factories.find(({ isDefault, status }) => isDefault && status === "active")?.name,
              )
              .catch(() => undefined)
          : undefined
      }
      initialData={initialData}
      personalConnections={
        category === "workspace" ? (
          <PersonalOAuthConnections
            afterOAuthGrant={afterOAuthGrant}
            history={resolvedSearchParams.oauthView === "history"}
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
      workspaceProfile={data.workspaceProfile}
    />
  );
}
