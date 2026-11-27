import { Suspense } from "react";
import { z } from "zod";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { AutomationPreviewLink } from "@/features/settings/automation-preview-link";
import { ConnectorSettingsSection } from "@/features/settings/connector-settings/section";
import { PersonalOAuthConnections } from "@/features/settings/personal-oauth-connections";
import { PersonalProviderAccess } from "@/features/settings/personal-provider-access";
import { loadSettingsPageData } from "@/features/settings/data";
import { parseSettingsCategory } from "@/features/settings/settings-categories";
import {
  SettingsSectionFallback,
  SettingsServerShell,
} from "@/features/settings/settings-server-shell";
import { WorkspaceFactoriesSection } from "@/features/settings/workspace-factories-section";
import { WorkspaceOAuthClients } from "@/features/settings/workspace-oauth-clients";

type SettingsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<{
    github?: string;
    codex_connect?: string;
    category?: string | string[];
    factory?: string | string[];
    manageFactory?: string | string[];
    afterOAuthClient?: string | string[];
    afterOAuthGrant?: string | string[];
    oauthView?: string | string[];
    provider?: string;
  }>;
};

export default async function SettingsPage({ params, searchParams }: SettingsPageProps) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const category = parseSettingsCategory(
    resolvedSearchParams.category ?? (resolvedSearchParams.codex_connect ? "personal" : undefined),
  );
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
        category === "personal" ? (
          <PersonalOAuthConnections
            afterOAuthGrant={afterOAuthGrant}
            history={resolvedSearchParams.oauthView === "history"}
            workspaceSlug={workspaceSlug}
          />
        ) : undefined
      }
      personalProviderAccess={
        data.personalProviderContext ? (
          <PersonalProviderAccess
            canManageWorkspace={initialData.canManage}
            codexStatus={resolvedSearchParams.codex_connect}
            context={data.personalProviderContext}
            requestedProvider={resolvedSearchParams.provider}
            workspaceId={initialData.workspace.id}
            workspaceSlug={workspaceSlug}
          />
        ) : undefined
      }
      searchState={{
        githubStatus: resolvedSearchParams.github ?? null,
      }}
      setupData={data.setupData}
      usage={data.usage}
      workspaceFactories={
        category === "workspace" ? (
          <WorkspaceFactoriesSection
            canManage={initialData.canManage}
            factories={loadWorkspaceFactoryOptions(workspaceSlug)}
            requestedManagement={
              z.string().uuid().safeParse(resolvedSearchParams.manageFactory).data
            }
            requestedSetup={resolvedSearchParams.factory}
            workspace={initialData.workspace}
          />
        ) : undefined
      }
      workspaceInvitations={data.workspaceInvitations}
      workspaceOAuthClients={
        category === "workspace" && initialData.canManage ? (
          <WorkspaceOAuthClients
            afterOAuthClient={
              z.string().uuid().safeParse(resolvedSearchParams.afterOAuthClient).data
            }
            afterOAuthGrant={afterOAuthGrant}
            workspaceSlug={workspaceSlug}
          />
        ) : undefined
      }
      workspaceProfile={data.workspaceProfile}
    />
  );
}
