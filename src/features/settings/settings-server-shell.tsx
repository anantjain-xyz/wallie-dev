import { Suspense } from "react";

import type {
  SettingsInitialData,
  SettingsPageData,
  SettingsSetupData,
  WorkspaceUsageData,
} from "@/features/settings/data";
import { MaintenanceIsland, VerifySetupIsland } from "@/features/settings/islands/advanced-islands";
import {
  GithubIntegrationIsland,
  LinearIntegrationIsland,
  RepositoryIntegrationIsland,
  RuntimeIntegrationIsland,
  VercelIntegrationIsland,
} from "@/features/settings/islands/integration-islands";
import { PipelineIsland } from "@/features/settings/islands/pipeline-island";
import {
  DangerActionsIsland,
  WorkspaceIdentityIsland,
  WorkspaceMembersIsland,
} from "@/features/settings/islands/workspace-islands";
import { SettingsCategoryNav } from "@/features/settings/settings-category-nav";
import {
  settingsCategoryMeta,
  type SettingsCategory,
} from "@/features/settings/settings-categories";
import { SettingsDirtyRegistryProvider } from "@/features/settings/settings-dirty-registry";
import { Section, UsageSummary } from "@/features/settings/settings-ui";
import type { WorkspaceInvitation } from "@/lib/workspace-invitations/contracts";

type SettingsServerShellProps = {
  category: SettingsCategory;
  initialData: SettingsInitialData;
  searchState: { codexStatus: string | null; githubStatus: string | null };
  setupData: Promise<SettingsSetupData>;
  usage: Promise<WorkspaceUsageData>;
  workspaceInvitations: Promise<WorkspaceInvitation[]>;
};

const EMPTY_USAGE: WorkspaceUsageData = {
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalRuns: 0,
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
      <div className="h-5 w-40 animate-pulse rounded bg-control-hover" />
      <div className="mt-4 h-4 w-full max-w-xl animate-pulse rounded bg-control-hover" />
      <div className="mt-8 h-20 animate-pulse rounded bg-control-hover" />
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

function CategoryPermissionNotice({ canManage }: { canManage: boolean }) {
  if (canManage) return null;
  return (
    <div
      className="rounded-[6px] border border-border bg-sheet px-4 py-3 text-sm text-muted"
      role="status"
    >
      You can view this category. Workspace admins and owners can change these settings.
    </div>
  );
}

async function IntegrationDetails({
  initialData,
  setupData,
}: Pick<SettingsServerShellProps, "initialData" | "setupData">) {
  const setup = await settle(setupData);
  if (!setup.ok) {
    return <SettingsSectionError label="Integration details" minHeight="min-h-96" />;
  }
  const data = completeSettingsData(initialData, setup.value);
  return (
    <>
      <div aria-label="Integration sections" className="flex flex-wrap gap-2">
        <a className="ui-button" href="#repository">
          Repositories
        </a>
        <a className="ui-button" href="#vercel">
          Vercel
        </a>
        <a className="ui-button" href="#linear">
          Linear
        </a>
      </div>
      <RepositoryIntegrationIsland initialData={data} />
      <VercelIntegrationIsland initialData={data} />
      <LinearIntegrationIsland initialData={data} />
    </>
  );
}

function IntegrationsCategory(props: SettingsServerShellProps) {
  return (
    <div className="space-y-16">
      <CategoryPermissionNotice canManage={props.initialData.canManage} />
      <GithubIntegrationIsland
        canManage={props.initialData.canManage}
        github={props.initialData.github}
        githubStatus={props.searchState.githubStatus}
        workspaceId={props.initialData.workspace.id}
      />
      <Suspense
        fallback={<SettingsSectionFallback label="integration details" minHeight="min-h-96" />}
      >
        <IntegrationDetails initialData={props.initialData} setupData={props.setupData} />
      </Suspense>
    </div>
  );
}

async function AgentExecutionCategory({
  initialData,
  searchState,
  setupData,
}: SettingsServerShellProps) {
  const setup = await settle(setupData);
  if (!setup.ok) {
    return <SettingsSectionError label="Agent execution" minHeight="min-h-96" />;
  }
  return (
    <RuntimeIntegrationIsland
      codexStatus={searchState.codexStatus}
      initialData={completeSettingsData(initialData, setup.value)}
    />
  );
}

async function PipelineCategory({ initialData, setupData }: SettingsServerShellProps) {
  const setup = await settle(setupData);
  if (!setup.ok) {
    return <SettingsSectionError label="Pipeline" minHeight="min-h-96" />;
  }
  return <PipelineIsland data={completeSettingsData(initialData, setup.value)} />;
}

async function UsageSection({
  canManage,
  usage,
  workspaceId,
}: {
  canManage: boolean;
  usage: Promise<WorkspaceUsageData>;
  workspaceId: string;
}) {
  const result = await settle(usage);
  if (!result.ok) {
    return <SettingsSectionError label="Usage" />;
  }
  return (
    <Section
      anchorId="usage"
      tagline="Aggregate token usage and costs across all agent runs in this workspace."
      title="Usage"
    >
      <UsageSummary usage={result.value} />
      <MaintenanceIsland canManage={canManage} workspaceId={workspaceId} />
    </Section>
  );
}

async function AdvancedDetails({ initialData, setupData }: SettingsServerShellProps) {
  const setup = await settle(setupData);
  if (!setup.ok) {
    return <SettingsSectionError label="Setup health" minHeight="min-h-96" />;
  }
  const data = completeSettingsData(initialData, setup.value);
  return (
    <>
      <VerifySetupIsland initialData={data} />
      <Section
        anchorId="rate-limits"
        tagline="Per-endpoint caps protecting sandbox spawns and paid LLM calls."
        title="Rate limits"
      >
        <ul className="ui-sheet divide-y divide-border">
          {data.rateLimits.map((limit) => (
            <li className="flex justify-between gap-4 px-5 py-4" key={limit.endpoint}>
              <div>
                <code className="font-mono text-xs text-foreground">{limit.endpoint}</code>
                <p className="mt-1 text-xs text-muted">{limit.description}</p>
              </div>
              <span className="shrink-0 font-mono type-annotation text-muted">
                {limit.max} / {Math.round(limit.windowMs / 1000)}s
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function AdvancedCategory(props: SettingsServerShellProps) {
  return (
    <div className="space-y-16">
      <CategoryPermissionNotice canManage={props.initialData.canManage} />
      <Suspense fallback={<SettingsSectionFallback label="setup health" minHeight="min-h-96" />}>
        <AdvancedDetails {...props} />
      </Suspense>
      <Suspense fallback={<SettingsSectionFallback label="usage" />}>
        <UsageSection
          canManage={props.initialData.canManage}
          usage={props.usage}
          workspaceId={props.initialData.workspace.id}
        />
      </Suspense>
      <DangerActionsIsland initialData={props.initialData} />
    </div>
  );
}

function GeneralCategory(props: SettingsServerShellProps) {
  return (
    <div className="space-y-8">
      <CategoryPermissionNotice canManage={props.initialData.canManage} />
      <WorkspaceIdentityIsland initialData={props.initialData} />
    </div>
  );
}

async function MembersSection({
  initialData,
  setupData,
  workspaceInvitations,
}: SettingsServerShellProps) {
  const result = await settle(Promise.all([setupData, workspaceInvitations]));
  if (!result.ok) {
    return <SettingsSectionError label="Members and invitations" />;
  }
  const [setup, invitations] = result.value;
  return (
    <WorkspaceMembersIsland
      initialData={completeSettingsData(initialData, setup)}
      invitations={invitations}
    />
  );
}

function MembersCategory(props: SettingsServerShellProps) {
  return (
    <div className="space-y-8">
      <CategoryPermissionNotice canManage={props.initialData.canManage} />
      <Suspense fallback={<SettingsSectionFallback label="members and invitations" />}>
        <MembersSection {...props} />
      </Suspense>
    </div>
  );
}

function ActiveCategory(props: SettingsServerShellProps) {
  switch (props.category) {
    case "general":
      return <GeneralCategory {...props} />;
    case "integrations":
      return <IntegrationsCategory {...props} />;
    case "agent-execution":
      return (
        <div className="space-y-8">
          <CategoryPermissionNotice canManage={props.initialData.canManage} />
          <Suspense
            fallback={<SettingsSectionFallback label="agent execution" minHeight="min-h-96" />}
          >
            <AgentExecutionCategory {...props} />
          </Suspense>
        </div>
      );
    case "pipeline":
      return (
        <div className="space-y-8">
          <CategoryPermissionNotice canManage={props.initialData.canManage} />
          <Suspense fallback={<SettingsSectionFallback label="pipeline" minHeight="min-h-96" />}>
            <PipelineCategory {...props} />
          </Suspense>
        </div>
      );
    case "members":
      return <MembersCategory {...props} />;
    case "advanced":
      return <AdvancedCategory {...props} />;
  }
}

export function SettingsServerShell(props: SettingsServerShellProps) {
  const meta = settingsCategoryMeta(props.category);

  return (
    <SettingsDirtyRegistryProvider>
      <main className="min-h-full">
        <div className="mx-auto max-w-[1080px] px-4 pb-24 pt-8 sm:px-8 sm:pt-10">
          <header className="mb-8 sm:mb-10">
            <p className="type-annotation text-muted">Settings</p>
            <h1 className="type-page-title mt-1">{meta.label}</h1>
            <p className="type-body mt-2 max-w-2xl text-muted">{meta.purpose}</p>
          </header>
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
            <SettingsCategoryNav
              activeCategory={props.category}
              workspaceSlug={props.initialData.workspace.slug}
            />
            <div className="min-w-0">
              <ActiveCategory {...props} />
            </div>
          </div>
        </div>
      </main>
    </SettingsDirtyRegistryProvider>
  );
}
