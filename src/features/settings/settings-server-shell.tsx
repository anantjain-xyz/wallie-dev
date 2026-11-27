import { Suspense, type ReactNode } from "react";

import { AdvancedRateLimits } from "@/features/settings/advanced-rate-limits";
import type {
  SettingsInitialData,
  SettingsPageData,
  SettingsSetupData,
  SettingsWorkspaceProfile,
  WorkspaceInvitationsSnapshot,
  WorkspaceUsageData,
} from "@/features/settings/data";
import {
  FactorySettingsPanel,
  FactorySettingsProvider,
} from "@/features/settings/factory-settings";
import {
  MaintenanceIsland,
  RunHistoryIsland,
  VerifySetupIsland,
} from "@/features/settings/islands/advanced-islands";
import {
  GithubIntegrationIsland,
  LinearIntegrationIsland,
  RepositoryIntegrationIsland,
  RuntimeIntegrationIsland,
  VercelIntegrationIsland,
  WorkspaceSecretsIntegrationIsland,
} from "@/features/settings/islands/integration-islands";
import { PipelineIsland } from "@/features/settings/islands/pipeline-island";
import {
  DangerActionsIsland,
  WorkspaceIdentityIsland,
} from "@/features/settings/islands/workspace-islands";
import { SettingsCategoryNav } from "@/features/settings/settings-category-nav";
import type { SettingsCategory } from "@/features/settings/settings-categories";
import { Section, UsageSummary } from "@/features/settings/settings-ui";
import {
  WorkspaceMemberSettings,
  WorkspacePersonalProfile,
} from "@/features/settings/workspace-member-settings";
import { workspaceFactoryDefinitionPath } from "@/lib/routes";

type SettingsServerShellProps = {
  automationPreview?: ReactNode;
  category: SettingsCategory;
  connectorSettings?: ReactNode;
  defaultFactoryName?: Promise<string | undefined>;
  initialData: SettingsInitialData;
  personalConnections?: ReactNode;
  personalProviderAccess?: ReactNode;
  searchState: { githubStatus: string | null };
  setupData: Promise<SettingsSetupData>;
  usage: Promise<WorkspaceUsageData>;
  workspaceFactories?: ReactNode;
  workspaceInvitations: Promise<WorkspaceInvitationsSnapshot>;
  workspaceOAuthClients?: ReactNode;
  workspaceProfile?: Promise<SettingsWorkspaceProfile>;
};

const EMPTY_USAGE: WorkspaceUsageData = {
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalRuns: 0,
  tokensUnavailable: false,
  costUnavailable: false,
  hasEstimatedTokens: false,
  hasEstimatedCost: false,
};

function completeSettingsData(
  initialData: SettingsInitialData,
  setupData: SettingsSetupData,
): SettingsPageData {
  return {
    ...initialData,
    ...setupData,
    usage: EMPTY_USAGE,
    workspaceInvitations: [],
  };
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await promise };
  } catch {
    return { ok: false };
  }
}

export function SettingsSectionFallback({
  label,
  minHeight = "min-h-52",
}: {
  label: string;
  minHeight?: string;
}) {
  return (
    <section
      aria-busy="true"
      aria-label={`Loading ${label}`}
      className={`${minHeight} rounded-[6px] border border-border bg-sheet p-5`}
      role="status"
    >
      <div className="h-5 w-40 animate-pulse rounded bg-control-hover motion-reduce:animate-none" />
      <div className="mt-4 h-4 w-full max-w-xl animate-pulse rounded bg-control-hover motion-reduce:animate-none" />
      <div className="mt-8 h-20 animate-pulse rounded bg-control-hover motion-reduce:animate-none" />
    </section>
  );
}

export function SettingsSectionError({
  label,
  minHeight = "min-h-52",
}: {
  label: string;
  minHeight?: string;
}) {
  return (
    <section
      className={`${minHeight} rounded-[6px] border border-danger/20 bg-danger-soft p-5 text-danger`}
      role="alert"
    >
      <h2 className="text-[15px] font-semibold">{label} unavailable</h2>
      <p className="mt-2 text-sm">Refresh the page to try loading this section again.</p>
    </section>
  );
}

async function WorkspaceConnectionDetails({ initialData, setupData }: SettingsServerShellProps) {
  const setup = await settle(setupData);
  if (!setup.ok) {
    return <SettingsSectionError label="Integration details" minHeight="min-h-96" />;
  }
  const data = completeSettingsData(initialData, setup.value);
  return (
    <>
      <RepositoryIntegrationIsland initialData={data} />
      <LinearIntegrationIsland initialData={data} />
      <VercelIntegrationIsland initialData={data} />
      <WorkspaceSecretsIntegrationIsland initialData={data} />
    </>
  );
}

async function IntegrationDetails({
  defaultFactoryName,
  initialData,
  setupData,
}: SettingsServerShellProps) {
  const setup = await settle(setupData);
  if (!setup.ok) {
    return <SettingsSectionError label="Factory configuration and setup checks" />;
  }
  const data = completeSettingsData(initialData, setup.value);
  const factoryName = await defaultFactoryName;
  return (
    <>
      <Section
        anchorId="factory-configuration"
        tagline={`${factoryName ? `${factoryName} is the workspace default.` : "These settings are for the workspace default."}${data.canManage ? " Changes saved to a draft apply to new sessions only after you publish." : ""}`}
        title="Default factory configuration"
      >
        <FactorySettingsPanel
          editorHref={
            data.canManage ? workspaceFactoryDefinitionPath(data.workspace.slug) : undefined
          }
        />
      </Section>
      <PipelineIsland data={data} factoryName={factoryName} />
      <RuntimeIntegrationIsland defaultFactoryName={factoryName} initialData={data} />
      <VerifySetupIsland defaultFactoryName={factoryName} initialData={data} />
    </>
  );
}

function IntegrationsCategory(props: SettingsServerShellProps) {
  const { canManage, github, workspace } = props.initialData;
  return (
    <FactorySettingsProvider canManage={canManage} key={workspace.id} workspaceId={workspace.id}>
      <div className="space-y-10 sm:space-y-12">
        <Section
          title="Workspace connections"
          tagline={`These settings apply to ${workspace.name}.`}
        >
          <div className="space-y-6 sm:space-y-8">
            <GithubIntegrationIsland
              canManage={canManage}
              github={github}
              githubStatus={props.searchState.githubStatus}
              workspaceId={workspace.id}
            />
            <Suspense
              fallback={
                <SettingsSectionFallback label="integration details" minHeight="min-h-96" />
              }
            >
              <WorkspaceConnectionDetails {...props} />
            </Suspense>
          </div>
        </Section>
        <div className="space-y-4">
          {props.connectorSettings}
          {props.automationPreview}
        </div>
        <Suspense
          fallback={
            <SettingsSectionFallback label="default factory configuration and setup checks" />
          }
        >
          <IntegrationDetails {...props} />
        </Suspense>
      </div>
    </FactorySettingsProvider>
  );
}

async function UsageSection({ usage }: { usage: Promise<WorkspaceUsageData> }) {
  const result = await settle(usage);
  if (!result.ok) {
    return <SettingsSectionError label="Usage" />;
  }
  return (
    <Section
      anchorId="usage"
      tagline="All time · Runs that started in this workspace, including failed runs. Run costs reflect reported or estimated usage, not a provider bill."
      title="Usage"
    >
      <UsageSummary usage={result.value} />
    </Section>
  );
}

async function AdvancedDetails({ initialData, setupData }: SettingsServerShellProps) {
  const setup = await settle(setupData);
  if (!setup.ok) {
    return <SettingsSectionError label="Rate limits" minHeight="min-h-96" />;
  }
  const data = completeSettingsData(initialData, setup.value);
  return (
    <Section
      anchorId="rate-limits"
      tagline="Configured request caps are read-only. They don’t show how many requests you have left."
      title="Rate limits"
    >
      <AdvancedRateLimits limits={data.rateLimits} />
    </Section>
  );
}

function AdvancedCategory(props: SettingsServerShellProps) {
  return (
    <div className="space-y-10 sm:space-y-12">
      <Suspense fallback={<SettingsSectionFallback label="usage" />}>
        <UsageSection usage={props.usage} />
      </Suspense>
      {props.initialData.canManage ? (
        <>
          <Section
            anchorId="run-history"
            tagline="Set how long this workspace keeps run content, or request a private export. Shorter limits can permanently remove older content and expire affected exports."
            title="Retention and exports"
          >
            <RunHistoryIsland workspaceId={props.initialData.workspace.id} />
          </Section>
          <Section
            anchorId="maintenance"
            tagline="Recover stalled work and refresh linked Linear and GitHub state."
            title="Maintenance"
          >
            <MaintenanceIsland
              canManage
              workspaceId={props.initialData.workspace.id}
              workspaceName={props.initialData.workspace.name}
            />
          </Section>
        </>
      ) : null}
      <Suspense fallback={<SettingsSectionFallback label="rate limits" minHeight="min-h-96" />}>
        <AdvancedDetails {...props} />
      </Suspense>
    </div>
  );
}

function WorkspaceCategory(props: SettingsServerShellProps) {
  return (
    <div className="space-y-10 sm:space-y-12">
      <WorkspaceIdentityIsland initialData={props.initialData} />
      {props.workspaceFactories}
      <WorkspaceMemberSettings
        initialData={props.initialData}
        invitations={props.workspaceInvitations}
        setup={props.setupData}
      />
      {props.initialData.canManage && props.workspaceOAuthClients ? (
        <Suspense fallback={<SettingsSectionFallback label="workspace OAuth clients" />}>
          {props.workspaceOAuthClients}
        </Suspense>
      ) : null}
      <DangerActionsIsland initialData={props.initialData} />
    </div>
  );
}

function PersonalCategory(props: SettingsServerShellProps) {
  return (
    <div className="space-y-10 sm:space-y-12">
      {props.workspaceProfile ? (
        <WorkspacePersonalProfile profile={props.workspaceProfile} />
      ) : null}
      {props.personalProviderAccess ? (
        <Suspense fallback={<SettingsSectionFallback label="provider access" />}>
          {props.personalProviderAccess}
        </Suspense>
      ) : null}
      {props.personalConnections ? (
        <Suspense fallback={<SettingsSectionFallback label="connected clients" />}>
          {props.personalConnections}
        </Suspense>
      ) : null}
    </div>
  );
}

function ActiveCategory(props: SettingsServerShellProps) {
  switch (props.category) {
    case "advanced":
      return <AdvancedCategory {...props} />;
    case "workspace":
      return <WorkspaceCategory {...props} />;
    case "personal":
      return <PersonalCategory {...props} />;
    default:
      return <IntegrationsCategory {...props} />;
  }
}

export function SettingsServerShell(props: SettingsServerShellProps) {
  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-[1080px] px-4 pb-24 pt-6 sm:px-8 sm:pt-10">
        <header className="mb-4 sm:mb-8">
          <h1 className="type-page-title">Settings</h1>
        </header>
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
          <SettingsCategoryNav
            activeCategory={props.category}
            canManage={props.initialData.canManage}
            workspaceSlug={props.initialData.workspace.slug}
          />
          <div className="min-w-0" id="settings-sections">
            <ActiveCategory {...props} />
          </div>
        </div>
      </div>
    </div>
  );
}
