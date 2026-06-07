"use client";

import { useState } from "react";

import type { UpsertAgentConfigResponse } from "@/app/api/agent-config/route";
import { AgentConfigSection } from "@/features/settings/agent-config-section";
import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import type { SettingsPageData } from "@/features/settings/data";
import { GitHubInstallSection } from "@/features/settings/github-install-section";
import { LinearConfigurationSection } from "@/features/settings/linear-configuration-section";
import { MaintenancePanel } from "@/features/settings/maintenance-panel";
import { PipelineEditor } from "@/features/settings/pipeline-editor";
import { RepositoryAnalysisSection } from "@/features/settings/repository-analysis-section";
import { WorkspaceSecretsPanel } from "@/features/settings/secrets-section";
import { type SettingsAnchor, SettingsAnchorNav } from "@/features/settings/settings-anchor-nav";
import type { FlashMessage, SettingsPageClientProps } from "@/features/settings/settings-types";
import { Section, toneClass, UsageSummary } from "@/features/settings/settings-ui";
import {
  VercelSandboxConnectionSection,
  vercelConnectionHealth,
} from "@/features/settings/vercel-sandbox-connection-section";
import { VerifySetupSection } from "@/features/settings/verify-setup-section";
import { WorkspaceAvatarSection } from "@/features/settings/workspace-avatar-section";
import { WorkspaceMembersSection } from "@/features/settings/workspace-members-section";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import { configuredAgentConfigKeys } from "@/features/onboarding/runtime-readiness";
import type { AgentConfigKey } from "@/lib/agent-config/contracts";

const ANCHORS: SettingsAnchor[] = [
  { id: "workspace", label: "Workspace" },
  { id: "members", label: "Members" },
  { id: "github", label: "Connect GitHub" },
  { id: "repository", label: "Analyze repositories" },
  { id: "vercel", label: "Connect Vercel" },
  { id: "pipeline", label: "Review pipeline" },
  { id: "linear", label: "Connect Linear" },
  { id: "runtime", label: "Connect Agent" },
  { id: "verify", label: "Verify setup" },
  { dividerBefore: true, id: "usage", label: "Usage" },
  { id: "rate-limits", label: "Rate limits" },
];

const LEGACY_ANCHOR_REDIRECTS: Record<string, string> = {
  "cloud-execution": "verify",
  "coding-agent": "runtime",
  "linear-routing": "linear",
  secrets: "runtime",
};

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

function updateGithubInData(
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
  entry: UpsertAgentConfigResponse["entry"],
): SettingsPageData {
  const agentConfig = { ...currentData.agentConfig };
  agentConfig[entry.key as AgentConfigKey] = entry.value;
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
        connected: status.connected,
        credentialType: status.credentialType ?? null,
        expiresAt: status.expiresAt ?? null,
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

export function SettingsPageClient({ initialData, searchState }: SettingsPageClientProps) {
  const [data, setData] = useState(initialData);
  const [secrets, setSecrets] = useState(initialData.workspaceSecrets);
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(
    initialFlashMessage(searchState),
  );
  const pageData = applySecretsToData(data, secrets);
  const isManager = pageData.canManage;
  const linearSecret = pageData.linearSecret;

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-[1080px] px-4 pb-24 pt-8 sm:px-8 sm:pt-10">
        <header className="mb-8 sm:mb-10">
          <div className="min-w-0 space-y-2">
            <h1 className="text-[26px] font-semibold tracking-tight text-foreground sm:text-[28px]">
              Settings
            </h1>
            <p className="max-w-2xl text-[14px] leading-6 text-muted">
              Manage workspace identity, members, integrations, pipeline, and encrypted secrets.
            </p>
          </div>
        </header>

        {flashMessage ? (
          <div
            aria-live="polite"
            className={`mb-8 rounded-[10px] border px-4 py-3 text-sm ${toneClass(flashMessage.kind)}`}
            role="status"
          >
            {flashMessage.text}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[180px_minmax(0,1fr)]">
          <SettingsAnchorNav anchors={ANCHORS} legacyRedirects={LEGACY_ANCHOR_REDIRECTS} />

          <div className="space-y-16 min-w-0">
            <WorkspaceAvatarSection
              canManage={isManager}
              setFlashMessage={setFlashMessage}
              workspace={pageData.workspace}
            />
            <WorkspaceMembersSection
              canManage={isManager}
              initialInvitations={pageData.workspaceInvitations}
              setFlashMessage={setFlashMessage}
              workspaceId={pageData.workspace.id}
              workspaceMembers={pageData.workspaceMembers}
            />
            <GitHubInstallSection
              canManage={isManager}
              github={pageData.github}
              onGithubChange={(github) =>
                setData((currentData) => updateGithubInData(currentData, github))
              }
              setFlashMessage={setFlashMessage}
              workspaceId={pageData.workspace.id}
            />
            <RepositoryAnalysisSection
              data={pageData}
              setData={setData}
              setFlashMessage={setFlashMessage}
            />

            <VercelSandboxConnectionSection
              canManage={isManager}
              connection={pageData.vercelSandboxConnection}
              onConnectionChange={(connection) =>
                setData((currentData) => updateVercelConnectionInData(currentData, connection))
              }
              setFlashMessage={setFlashMessage}
              workspaceId={pageData.workspace.id}
            />

            <Section
              anchorId="pipeline"
              tagline="Stages run in order; each stage's prompt is sent to the agent, and an approver reviews the markdown output before the session advances."
              title="Review pipeline"
            >
              <PipelineEditor
                canManage={isManager}
                pipeline={pageData.pipeline}
                workspaceId={pageData.workspace.id}
                workspaceMembers={pageData.workspaceMembers}
              />
            </Section>

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

            <AgentConfigSection
              anchorId="runtime"
              canManage={isManager}
              codexConnectFlash={searchState.codexStatus}
              extraContent={
                <div className="space-y-4 border-t border-border pt-6">
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-semibold text-foreground">Workspace secrets</h3>
                    <p className="mt-1 text-[12px] leading-5 text-muted">
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
              onAgentConfigSaved={(entry) =>
                setData((currentData) => updateAgentConfigInData(currentData, entry))
              }
              onClaudeCodeStatusChange={(status) =>
                setData((currentData) => updateClaudeCodeConnectionInData(currentData, status))
              }
              onCodexStatusChange={(status) =>
                setData((currentData) => updateCodexConnectionInData(currentData, status))
              }
              setFlashMessage={setFlashMessage}
              tagline="Check coding-agent configuration, provider access, and workspace secrets used by Wallie runtime."
              title="Connect Agent"
              vercelSandboxConnection={pageData.vercelSandboxConnection}
              workspaceId={pageData.workspace.id}
            />

            <VerifySetupSection
              data={pageData}
              setData={setData}
              setFlashMessage={setFlashMessage}
            />

            <Section
              anchorId="usage"
              tagline="Aggregate token usage and costs across all agent runs in this workspace."
              title="Usage"
            >
              <UsageSummary usage={pageData.usage} />
              <MaintenancePanel
                canManage={isManager}
                setFlashMessage={setFlashMessage}
                workspaceId={pageData.workspace.id}
              />
            </Section>

            <Section
              anchorId="rate-limits"
              tagline="Per-endpoint caps protecting sandbox spawns and paid LLM calls. Excess requests return 429 with a Retry-After header."
              title="Rate limits"
            >
              <ul className="divide-y divide-border rounded-[10px] border border-border bg-surface">
                {pageData.rateLimits.map((limit) => (
                  <li
                    key={limit.endpoint}
                    className="flex flex-col gap-1.5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1">
                      <code className="font-mono text-[12px] text-foreground">
                        {limit.endpoint}
                      </code>
                      <p className="text-[12px] leading-5 text-muted">{limit.description}</p>
                    </div>
                    <span className="ui-pill shrink-0">
                      {limit.max} req / {Math.round(limit.windowMs / 1000)}s
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
