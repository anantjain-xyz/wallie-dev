"use client";

import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";

import type { AgentConfigEntry } from "@/app/api/agent-config/route";
import { useOptionalToast } from "@/components/ui/toast";
import { AgentConfigSection } from "@/features/settings/agent-config-section";
import { DangerZoneSection } from "@/features/settings/danger-zone-section";
import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import type {
  SettingsInitialData,
  SettingsPageData,
  SettingsSetupData,
  WorkspaceUsageData,
} from "@/features/settings/data";
import { GitHubInstallSection } from "@/features/settings/github-install-section";
import { LinearConfigurationSection } from "@/features/settings/linear-configuration-section";
import { SettingsDeferredSectionsSkeleton } from "@/features/settings/loading-skeleton";
import { MaintenancePanel } from "@/features/settings/maintenance-panel";
import { PipelineEditor, PipelineUnsavedBadge } from "@/features/settings/pipeline-editor";
import { RepositoryAnalysisSection } from "@/features/settings/repository-analysis-section";
import { WorkspaceSecretsPanel } from "@/features/settings/secrets-section";
import {
  type SettingsAnchorGroup,
  SettingsAnchorNav,
} from "@/features/settings/settings-anchor-nav";
import type { FlashMessage, SettingsPageClientProps } from "@/features/settings/settings-types";
import { Section, UsageSummary } from "@/features/settings/settings-ui";
import {
  VercelSandboxConnectionSection,
  vercelConnectionHealth,
} from "@/features/settings/vercel-sandbox-connection-section";
import { VerifySetupSection } from "@/features/settings/verify-setup-section";
import { WorkspaceAvatarSection } from "@/features/settings/workspace-avatar-section";
import { WorkspaceMembersSection } from "@/features/settings/workspace-members-section";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import { configuredAgentConfigKeys } from "@/features/onboarding/runtime-readiness";
import type { WorkspaceInvitation } from "@/lib/workspace-invitations/contracts";

const ANCHOR_GROUPS: SettingsAnchorGroup[] = [
  {
    label: "Integrations",
    anchors: [
      { id: "github", label: "GitHub" },
      { id: "repository", label: "Repositories" },
      { id: "vercel", label: "Vercel Sandbox" },
      { id: "linear", label: "Linear" },
      { id: "runtime", label: "Agent" },
    ],
  },
  {
    label: "Pipeline",
    anchors: [{ id: "pipeline", label: "Pipeline" }],
  },
  {
    label: "Advanced",
    anchors: [
      { id: "verify", label: "Verify setup" },
      { id: "usage", label: "Usage" },
      { id: "rate-limits", label: "Rate limits" },
    ],
  },
  {
    label: "Workspace",
    anchors: [
      { id: "workspace", label: "Workspace" },
      { id: "members", label: "Members" },
      { id: "danger-zone", label: "Danger zone" },
    ],
  },
];

const LEGACY_ANCHOR_REDIRECTS: Record<string, string> = {
  "cloud-execution": "verify",
  "coding-agent": "runtime",
  "linear-routing": "linear",
  secrets: "runtime",
};

function ContainedSettingsSection({
  children,
  size = "default",
}: {
  children: ReactNode;
  size?: "compact" | "default" | "large";
}) {
  return (
    <div
      className={`settings-contained-section ${
        size === "default" ? "" : `settings-contained-section-${size}`
      }`}
    >
      {children}
    </div>
  );
}

function initialFlashMessage(searchState: SettingsPageClientProps["searchState"]) {
  switch (searchState.githubStatus) {
    case "connected":
      return {
        kind: "success",
        text: "GitHub App installation connected and repositories synced.",
      } satisfies FlashMessage;
    case "config_missing":
      return {
        kind: "error",
        text: "GitHub install completed, but Wallie is missing server config needed to finish the sync.",
      } satisfies FlashMessage;
    case "failed":
      return {
        kind: "error",
        text: "GitHub installation callback failed. Try the install flow again after checking server config.",
      } satisfies FlashMessage;
    case "invalid_state":
      return {
        kind: "error",
        text: "GitHub installation state expired or could not be verified. Start the install flow again from settings.",
      } satisfies FlashMessage;
    default:
      return null;
  }
}

function useFlashToasts(initialMessage: FlashMessage | null) {
  const { pushToast } = useOptionalToast();
  const initialKind = initialMessage?.kind;
  const initialText = initialMessage?.text;
  const setFlashMessage = useCallback(
    (message: FlashMessage) => {
      pushToast({
        priority: message.kind === "error" ? "assertive" : "polite",
        title: message.text,
        tone:
          message.kind === "error" ? "danger" : message.kind === "success" ? "success" : "neutral",
      });
    },
    [pushToast],
  );

  useEffect(() => {
    if (initialKind && initialText) setFlashMessage({ kind: initialKind, text: initialText });
  }, [initialKind, initialText, setFlashMessage]);

  return setFlashMessage;
}

export function updateGithubInData(
  currentData: SettingsPageData,
  github: SettingsPageData["github"],
): SettingsPageData {
  return {
    ...currentData,
    github,
    setupHealth: {
      ...currentData.setupHealth,
      githubInstallation: {
        connected: Boolean(github.installation && !github.installation.suspended),
        installationId: github.installation?.installationId ?? null,
        status: github.installation ? "present" : "missing",
        suspended: github.installation?.suspended ?? null,
        targetName: github.installation?.targetName ?? null,
        updatedAt: github.installation?.updatedAt ?? null,
      },
      ...buildRepositorySetupHealth(github, currentData.onboarding.selectedGithubRepositoryId),
    },
  };
}

function updateAgentConfigInData(
  currentData: SettingsPageData,
  entries: AgentConfigEntry[],
): SettingsPageData {
  const agentConfig = { ...currentData.agentConfig };
  for (const entry of entries) {
    agentConfig[entry.key] = entry.value;
  }
  const configuredKeys = configuredAgentConfigKeys(agentConfig);

  return {
    ...currentData,
    agentConfig,
    setupHealth: {
      ...currentData.setupHealth,
      agentConfig: {
        configured: configuredKeys.length > 0,
        configuredKeys,
        status: configuredKeys.length > 0 ? "present" : "missing",
        values: agentConfig,
      },
    },
  };
}

function updateCodexConnectionInData(
  currentData: SettingsPageData,
  status: CodexConnectionStatus,
): SettingsPageData {
  const expiredOrReconnect = Boolean(status.expired || status.reconnectRequired);
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      codexConnection: {
        accountEmail: status.accountEmail ?? null,
        checkedAt: status.checkedAt,
        connected: status.connected,
        credentialType: status.credentialType ?? null,
        expiresAt: status.expiresAt ?? null,
        reconnectReason: status.reconnectReason ?? null,
        reconnectRequired: status.reconnectRequired ?? false,
        status: status.connected ? "connected" : expiredOrReconnect ? "expired" : "missing",
        updatedAt: status.updatedAt ?? null,
      },
    },
  };
}

function updateClaudeCodeConnectionInData(
  currentData: SettingsPageData,
  status: ClaudeCodeConnectionStatus,
): SettingsPageData {
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      claudeCodeConnection: {
        checkedAt: status.checkedAt,
        connected: status.connected,
        status: status.connected ? "connected" : "missing",
        updatedAt: status.updatedAt ?? null,
      },
    },
  };
}

export function applyLinearRoutingToSettingsData(
  currentData: SettingsPageData,
  routing: SettingsPageData["linearRouting"],
  updatedAt = new Date().toISOString(),
): SettingsPageData {
  return {
    ...currentData,
    linearRouting: routing,
    setupHealth: {
      ...currentData.setupHealth,
      linearRouting: {
        configured: true,
        status: "present",
        updatedAt,
      },
    },
  };
}

function applySecretsToData(
  currentData: SettingsPageData,
  secrets: SettingsPageData["workspaceSecrets"],
): SettingsPageData {
  const managedLinearSecret = secrets.find((secret) => secret.key === "LINEAR_API_KEY") ?? null;
  const linearSecret = currentData.canManage
    ? managedLinearSecret
    : (managedLinearSecret ?? currentData.linearSecret);
  const linearKeyHealth: SettingsPageData["setupHealth"]["linearKey"] = currentData.canManage
    ? {
        configured: Boolean(linearSecret),
        status: linearSecret ? "present" : "missing",
        updatedAt: linearSecret?.updatedAt ?? null,
      }
    : currentData.setupHealth.linearKey;
  const workspaceSecretKeys = currentData.canManage
    ? [...new Set(secrets.map((secret) => secret.key))].sort()
    : currentData.setupHealth.workspaceSecrets.configuredKeys;

  return {
    ...currentData,
    linearSecret,
    setupHealth: {
      ...currentData.setupHealth,
      linearKey: linearKeyHealth,
      workspaceSecrets: {
        configuredKeys: workspaceSecretKeys,
      },
    },
    workspaceSecrets: secrets,
  };
}

function updateVercelConnectionInData(
  currentData: SettingsPageData,
  connection: SettingsPageData["vercelSandboxConnection"],
): SettingsPageData {
  const vercelProjectChanged =
    currentData.vercelSandboxConnection?.teamId !== connection?.teamId ||
    currentData.vercelSandboxConnection?.projectId !== connection?.projectId;
  const latestSandboxCapabilityCheck = vercelProjectChanged
    ? null
    : currentData.latestSandboxCapabilityCheck;

  return {
    ...currentData,
    latestSandboxCapabilityCheck,
    setupHealth: {
      ...currentData.setupHealth,
      latestSandboxCapabilityCheck,
      vercelSandboxConnection: vercelConnectionHealth(connection),
    },
    vercelSandboxConnection: connection,
  };
}

function SettingsCompletePage({
  deferredMode = false,
  initialData,
  searchState,
  streamedGithub,
  streamedUsage,
  streamedWorkspaceInvitations,
}: {
  deferredMode?: boolean;
  initialData: SettingsPageData;
  searchState: SettingsPageClientProps["searchState"];
  streamedGithub?: SettingsPageData["github"];
  streamedUsage?: Promise<WorkspaceUsageData>;
  streamedWorkspaceInvitations?: Promise<WorkspaceInvitation[]>;
}) {
  const [state, setState] = useState(() => ({
    data: initialData,
    streamedGithub,
  }));
  const [secrets, setSecrets] = useState(initialData.workspaceSecrets);
  const [pipelineDirty, setPipelineDirty] = useState(false);
  const setFlashMessage = useFlashToasts(deferredMode ? null : initialFlashMessage(searchState));

  if (streamedGithub !== state.streamedGithub) {
    setState({
      data: streamedGithub ? updateGithubInData(state.data, streamedGithub) : state.data,
      streamedGithub,
    });
  }

  function setData(update: SetStateAction<SettingsPageData>) {
    setState((current) => ({
      ...current,
      data: typeof update === "function" ? update(current.data) : update,
    }));
  }

  const pageData = applySecretsToData(state.data, secrets);
  const isManager = pageData.canManage;
  const isOwner = pageData.currentMember.role === "owner";
  const linearSecret = pageData.linearSecret;

  return (
    <div className={deferredMode ? "" : "min-h-full"}>
      <div
        className={deferredMode ? "" : "mx-auto max-w-[1080px] px-4 pb-24 pt-8 sm:px-8 sm:pt-10"}
      >
        {deferredMode ? null : (
          <header className="mb-8 sm:mb-10">
            <div className="min-w-0 space-y-2">
              <h1 className="type-page-title">Settings</h1>
              <p className="type-body max-w-2xl text-muted">
                Manage workspace identity, members, integrations, pipeline, and encrypted secrets.
              </p>
            </div>
          </header>
        )}

        <div
          className={
            deferredMode
              ? ""
              : "grid grid-cols-1 items-start gap-12 lg:grid-cols-[180px_minmax(0,1fr)]"
          }
        >
          {deferredMode ? null : (
            <SettingsAnchorNav groups={ANCHOR_GROUPS} legacyRedirects={LEGACY_ANCHOR_REDIRECTS} />
          )}

          <div className="space-y-16 min-w-0">
            {deferredMode ? null : (
              <GitHubInstallSection
                canManage={isManager}
                github={pageData.github}
                onGithubChange={(github) =>
                  setData((currentData) => updateGithubInData(currentData, github))
                }
                setFlashMessage={setFlashMessage}
                workspaceId={pageData.workspace.id}
              />
            )}
            <ContainedSettingsSection>
              <RepositoryAnalysisSection
                data={pageData}
                setData={setData}
                setFlashMessage={setFlashMessage}
              />
            </ContainedSettingsSection>

            <ContainedSettingsSection>
              <VercelSandboxConnectionSection
                canManage={isManager}
                connection={pageData.vercelSandboxConnection}
                onConnectionChange={(connection) =>
                  setData((currentData) => updateVercelConnectionInData(currentData, connection))
                }
                setFlashMessage={setFlashMessage}
                workspaceId={pageData.workspace.id}
              />
            </ContainedSettingsSection>

            <ContainedSettingsSection size="large">
              <LinearConfigurationSection
                canManage={isManager}
                isLoadingSecrets={false}
                linearSecret={linearSecret}
                onRoutingSaved={(routing) =>
                  setData((currentData) => applyLinearRoutingToSettingsData(currentData, routing))
                }
                routing={pageData.linearRouting}
                setSecrets={setSecrets}
                stages={pageData.pipeline?.stages ?? []}
                workspaceId={pageData.workspace.id}
              />
            </ContainedSettingsSection>

            <ContainedSettingsSection size="large">
              <AgentConfigSection
                anchorId="runtime"
                canManage={isManager}
                codexConnectFlash={searchState.codexStatus}
                extraContent={
                  <div className="space-y-4 border-t border-border pt-6">
                    <div className="min-w-0">
                      <h3 className="text-[14px] font-semibold text-foreground">
                        Workspace secrets
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted">
                        Secret values never come back to the client. Wallie shows preview-only rows
                        and writes encrypted values through route handlers.
                      </p>
                    </div>
                    <WorkspaceSecretsPanel
                      canManage={isManager}
                      isLoadingSecrets={false}
                      secrets={secrets}
                      setFlashMessage={setFlashMessage}
                      setSecrets={setSecrets}
                      workspaceId={pageData.workspace.id}
                    />
                  </div>
                }
                initialAgentConfig={pageData.agentConfig}
                initialClaudeCodeStatus={{
                  checkedAt: pageData.setupHealth.claudeCodeConnection.checkedAt,
                  connected: pageData.setupHealth.claudeCodeConnection.connected,
                  updatedAt: pageData.setupHealth.claudeCodeConnection.updatedAt,
                }}
                initialCodexStatus={{
                  accountEmail: pageData.setupHealth.codexConnection.accountEmail,
                  checkedAt: pageData.setupHealth.codexConnection.checkedAt,
                  connected: pageData.setupHealth.codexConnection.connected,
                  credentialType: pageData.setupHealth.codexConnection.credentialType,
                  expired: pageData.setupHealth.codexConnection.status === "expired",
                  expiresAt: pageData.setupHealth.codexConnection.expiresAt,
                  reconnectReason: pageData.setupHealth.codexConnection.reconnectReason,
                  reconnectRequired: pageData.setupHealth.codexConnection.reconnectRequired,
                  updatedAt: pageData.setupHealth.codexConnection.updatedAt,
                }}
                onAgentConfigSaved={(entries) =>
                  setData((currentData) => updateAgentConfigInData(currentData, entries))
                }
                onClaudeCodeStatusChange={(status) =>
                  setData((currentData) => updateClaudeCodeConnectionInData(currentData, status))
                }
                onCodexStatusChange={(status) =>
                  setData((currentData) => updateCodexConnectionInData(currentData, status))
                }
                setFlashMessage={setFlashMessage}
                tagline="Check coding-agent configuration, provider access, and workspace secrets used by Wallie runtime."
                title="Agent"
                vercelSandboxConnection={pageData.vercelSandboxConnection}
                workspaceId={pageData.workspace.id}
              />
            </ContainedSettingsSection>

            <ContainedSettingsSection size="large">
              <Section
                anchorId="pipeline"
                statusBadge={<PipelineUnsavedBadge dirty={pipelineDirty} />}
                tagline="Stages run in order; each stage's prompt is sent to the agent, and an approver reviews the markdown output before the session advances. Existing artifacts stay unchanged; in-progress sessions may follow the updated stage order when they advance."
                title="Pipeline"
              >
                <PipelineEditor
                  canManage={isManager}
                  onDirtyChange={setPipelineDirty}
                  pipeline={pageData.pipeline}
                  workspaceId={pageData.workspace.id}
                  workspaceMembers={pageData.workspaceMembers}
                />
              </Section>
            </ContainedSettingsSection>

            <ContainedSettingsSection>
              <VerifySetupSection
                data={pageData}
                setData={setData}
                setFlashMessage={setFlashMessage}
              />
            </ContainedSettingsSection>

            <ContainedSettingsSection size="compact">
              <Section
                anchorId="usage"
                tagline="Aggregate token usage and costs across all agent runs in this workspace."
                title="Usage"
              >
                {streamedUsage ? (
                  <Suspense fallback={<p className="text-sm text-muted">Loading usage…</p>}>
                    <StreamedUsageSummary usage={streamedUsage} />
                  </Suspense>
                ) : (
                  <UsageSummary usage={pageData.usage} />
                )}
                <MaintenancePanel
                  canManage={isManager}
                  setFlashMessage={setFlashMessage}
                  workspaceId={pageData.workspace.id}
                />
              </Section>
            </ContainedSettingsSection>

            <ContainedSettingsSection size="compact">
              <Section
                anchorId="rate-limits"
                tagline="Per-endpoint caps protecting sandbox spawns and paid LLM calls. Excess requests return 429 with a Retry-After header."
                title="Rate limits"
              >
                <ul className="ui-sheet divide-y divide-border">
                  {pageData.rateLimits.map((limit) => (
                    <li
                      key={limit.endpoint}
                      className="flex flex-col gap-1.5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-1">
                        <code className="font-mono text-xs text-foreground">{limit.endpoint}</code>
                        <p className="text-xs leading-5 text-muted">{limit.description}</p>
                      </div>
                      <span className="shrink-0 font-mono type-annotation text-muted">
                        {limit.max} req / {Math.round(limit.windowMs / 1000)}s
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            </ContainedSettingsSection>

            <ContainedSettingsSection>
              <WorkspaceAvatarSection
                canManage={isManager}
                onWorkspaceNameChange={(name) =>
                  setData((currentData) => ({
                    ...currentData,
                    workspace: { ...currentData.workspace, name },
                  }))
                }
                setFlashMessage={setFlashMessage}
                workspace={pageData.workspace}
              />
            </ContainedSettingsSection>

            <ContainedSettingsSection>
              {streamedWorkspaceInvitations ? (
                <Suspense fallback={<WorkspaceMembersLoadingFallback />}>
                  <StreamedWorkspaceMembersSection
                    canManage={isManager}
                    currentMemberId={pageData.currentMember.id}
                    setFlashMessage={setFlashMessage}
                    workspaceId={pageData.workspace.id}
                    workspaceInvitations={streamedWorkspaceInvitations}
                    workspaceMembers={pageData.workspaceMembers}
                  />
                </Suspense>
              ) : (
                <WorkspaceMembersSection
                  canManage={isManager}
                  currentMemberId={pageData.currentMember.id}
                  initialInvitations={pageData.workspaceInvitations}
                  setFlashMessage={setFlashMessage}
                  workspaceId={pageData.workspace.id}
                  workspaceMembers={pageData.workspaceMembers}
                />
              )}
            </ContainedSettingsSection>

            <ContainedSettingsSection size="compact">
              <DangerZoneSection
                canDelete={isOwner}
                workspaceId={pageData.workspace.id}
                workspaceName={pageData.workspace.name}
              />
            </ContainedSettingsSection>
          </div>
        </div>
      </div>
    </div>
  );
}

function isCompleteSettingsData(
  data: SettingsInitialData | SettingsPageData,
): data is SettingsPageData {
  return "usage" in data && "workspaceInvitations" in data;
}

function StreamedUsageSummary({ usage }: { usage: Promise<WorkspaceUsageData> }) {
  return <UsageSummary usage={use(usage)} />;
}

function WorkspaceMembersLoadingFallback() {
  return (
    <section aria-busy="true" aria-label="Loading workspace invitations" id="members">
      <header className="settings-section-header mb-6">
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-[18px] font-semibold tracking-tight text-foreground">Members</h2>
          <p className="text-xs leading-5 text-muted">Loading workspace invitations…</p>
        </div>
      </header>
    </section>
  );
}

function StreamedWorkspaceMembersSection({
  canManage,
  currentMemberId,
  setFlashMessage,
  workspaceId,
  workspaceInvitations,
  workspaceMembers,
}: {
  canManage: boolean;
  currentMemberId: string;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
  workspaceInvitations: Promise<WorkspaceInvitation[]>;
  workspaceMembers: SettingsPageData["workspaceMembers"];
}) {
  return (
    <WorkspaceMembersSection
      canManage={canManage}
      currentMemberId={currentMemberId}
      initialInvitations={use(workspaceInvitations)}
      setFlashMessage={setFlashMessage}
      workspaceId={workspaceId}
      workspaceMembers={workspaceMembers}
    />
  );
}

function SettingsDeferredPage({
  github,
  initialData,
  searchState,
  setupData,
  usage,
  workspaceInvitations,
}: {
  github: SettingsPageData["github"];
  initialData: SettingsInitialData;
  searchState: SettingsPageClientProps["searchState"];
  setupData: Promise<SettingsSetupData>;
  usage: Promise<WorkspaceUsageData>;
  workspaceInvitations: Promise<WorkspaceInvitation[]>;
}) {
  const resolvedSetupData = use(setupData);
  const completeData = updateGithubInData(
    {
      ...initialData,
      ...resolvedSetupData,
      usage: { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalRuns: 0 },
      workspaceInvitations: [],
    },
    github,
  );

  return (
    <SettingsCompletePage
      deferredMode
      initialData={completeData}
      searchState={searchState}
      streamedGithub={github}
      streamedUsage={usage}
      streamedWorkspaceInvitations={workspaceInvitations}
    />
  );
}

function SettingsStreamingPage({
  initialData,
  searchState,
  setupData,
  usage,
  workspaceInvitations,
}: {
  initialData: SettingsInitialData;
  searchState: SettingsPageClientProps["searchState"];
  setupData: Promise<SettingsSetupData>;
  usage: Promise<WorkspaceUsageData>;
  workspaceInvitations: Promise<WorkspaceInvitation[]>;
}) {
  const [github, setGithub] = useState(initialData.github);
  const setFlashMessage = useFlashToasts(initialFlashMessage(searchState));

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-[1080px] px-4 pb-24 pt-8 sm:px-8 sm:pt-10">
        <header className="mb-8 sm:mb-10">
          <div className="min-w-0 space-y-2">
            <h1 className="type-page-title">Settings</h1>
            <p className="type-body max-w-2xl text-muted">
              Manage workspace identity, members, integrations, pipeline, and encrypted secrets.
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-[180px_minmax(0,1fr)]">
          <SettingsAnchorNav groups={ANCHOR_GROUPS} legacyRedirects={LEGACY_ANCHOR_REDIRECTS} />

          <div className="space-y-16 min-w-0">
            <GitHubInstallSection
              canManage={initialData.canManage}
              github={github}
              onGithubChange={setGithub}
              setFlashMessage={setFlashMessage}
              workspaceId={initialData.workspace.id}
            />

            <Suspense fallback={<SettingsDeferredSectionsSkeleton />}>
              <SettingsDeferredPage
                github={github}
                initialData={initialData}
                searchState={searchState}
                setupData={setupData}
                usage={usage}
                workspaceInvitations={workspaceInvitations}
              />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsPageClient({
  initialData,
  searchState,
  setupData,
  usage,
  workspaceInvitations,
}: SettingsPageClientProps) {
  if (isCompleteSettingsData(initialData)) {
    return <SettingsCompletePage initialData={initialData} searchState={searchState} />;
  }

  if (!setupData || !usage || !workspaceInvitations) {
    throw new Error("Streaming Settings data promises are required.");
  }

  return (
    <SettingsStreamingPage
      initialData={initialData}
      searchState={searchState}
      setupData={setupData}
      usage={usage}
      workspaceInvitations={workspaceInvitations}
    />
  );
}
