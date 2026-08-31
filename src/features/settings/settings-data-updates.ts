import type { AgentConfigEntry } from "@/app/api/agent-config/route";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import { configuredAgentConfigKeys } from "@/features/onboarding/runtime-readiness";
import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import type { CursorConnectionStatus } from "@/features/settings/cursor-connection-panel";
import type { OpenCodeConnectionStatus } from "@/features/settings/opencode-connection-panel";
import type { SettingsPageData } from "@/features/settings/data";

export function updateGithubInSettingsData(
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

export function updatePipelineInSettingsData(
  currentData: SettingsPageData,
  pipeline: NonNullable<SettingsPageData["pipeline"]>,
): SettingsPageData {
  return {
    ...currentData,
    pipeline,
    setupHealth: {
      ...currentData.setupHealth,
      defaultPipeline: {
        configured: pipeline.stages.length > 0,
        pipelineId: pipeline.id,
        stageCount: pipeline.stages.length,
        status: pipeline.stages.length > 0 ? "ready" : "missing",
      },
    },
  };
}

export function updateLinearRoutingInSettingsData(
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

export function updateSecretsInSettingsData(
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

export function updateAgentConfigInSettingsData(
  currentData: SettingsPageData,
  entries: AgentConfigEntry[],
): SettingsPageData {
  const agentConfig = { ...currentData.agentConfig };
  for (const entry of entries) agentConfig[entry.key] = entry.value;
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

export function updateCodexConnectionInSettingsData(
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

export function updateClaudeCodeConnectionInSettingsData(
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

export function updateCursorConnectionInSettingsData(
  currentData: SettingsPageData,
  status: CursorConnectionStatus,
): SettingsPageData {
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      cursorConnection: {
        accountEmail: status.accountEmail ?? null,
        checkedAt: status.checkedAt,
        connected: status.connected,
        expiresAt: status.expiresAt ?? null,
        reconnectReason: status.reconnectReason ?? null,
        reconnectRequired: status.reconnectRequired ?? false,
        status: status.connected
          ? "connected"
          : status.expired || status.reconnectRequired
            ? "expired"
            : "missing",
        updatedAt: status.updatedAt ?? null,
      },
    },
  };
}

export function updateOpenCodeConnectionInSettingsData(
  currentData: SettingsPageData,
  status: OpenCodeConnectionStatus,
): SettingsPageData {
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      openCodeConnection: {
        checkedAt: status.checkedAt,
        connected: status.connected,
        status: status.connected ? "connected" : "missing",
        updatedAt: status.updatedAt ?? null,
      },
    },
  };
}
