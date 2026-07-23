"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import { AgentConfigSection } from "@/features/settings/agent-config-section";
import { GitHubInstallSection } from "@/features/settings/github-install-section";
import { LinearConfigurationSection } from "@/features/settings/linear-configuration-section";
import { RepositoryAnalysisSection } from "@/features/settings/repository-analysis-section";
import { WorkspaceSecretsPanel } from "@/features/settings/secrets-section";
import {
  applySandboxSettingsToData,
  SandboxProviderSection,
} from "@/features/settings/sandbox-provider-section";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { updateGithubInSettingsData } from "@/features/settings/settings-data-updates";
import {
  dispatchSettingsEvent,
  SETTINGS_GITHUB_CHANGED,
  SETTINGS_SANDBOX_CHANGED,
  SETTINGS_SECRETS_CHANGED,
  type GithubChangedDetail,
  type SandboxChangedDetail,
  type SecretsChangedDetail,
} from "@/features/settings/settings-island-events";
import type { AgentProvider } from "@/lib/agent-config/contracts";

export function preloadProviderIsland(provider: AgentProvider) {
  if (provider === "claude-code") {
    void import("@/features/settings/claude-code-connection-panel");
  } else {
    void import("@/features/settings/codex-connection-panel");
  }
}

export function ProviderIntentLink({ provider }: { provider: AgentProvider }) {
  return (
    <a
      className="ui-button"
      href="#runtime"
      onFocus={() => preloadProviderIsland(provider)}
      onPointerEnter={() => preloadProviderIsland(provider)}
    >
      Agent
    </a>
  );
}

export function GithubIntegrationIsland({
  canManage,
  github: initialGithub,
  githubStatus,
  workspaceId,
}: {
  canManage: boolean;
  github: SettingsPageData["github"];
  githubStatus: string | null;
  workspaceId: string;
}) {
  const [github, setGithub] = useState(initialGithub);
  const initialMessage: FlashMessage | null = (() => {
    switch (githubStatus) {
      case "connected":
        return {
          kind: "success",
          text: "GitHub App installation connected and repositories synced.",
        };
      case "config_missing":
        return {
          kind: "error",
          text: "GitHub install completed, but Wallie is missing server config needed to finish the sync.",
        };
      case "invalid_state":
        return {
          kind: "error",
          text: "GitHub installation state expired or could not be verified. Start the install flow again from settings.",
        };
      case "failed":
        return {
          kind: "error",
          text: "GitHub installation callback failed. Try the install flow again after checking server config.",
        };
      default:
        return null;
    }
  })();
  const { feedback, setMessage } = useIslandFeedback(initialMessage);

  return (
    <>
      {feedback}
      <GitHubInstallSection
        canManage={canManage}
        github={github}
        onGithubChange={(nextGithub) => {
          setGithub(nextGithub);
          dispatchSettingsEvent(SETTINGS_GITHUB_CHANGED, nextGithub);
        }}
        setFlashMessage={setMessage}
        workspaceId={workspaceId}
      />
    </>
  );
}

export function RepositoryIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const [data, setData] = useState(initialData);
  const { feedback, setMessage } = useIslandFeedback();
  useEffect(() => {
    const handleGithubChange = (event: Event) => {
      const github = (event as CustomEvent<GithubChangedDetail>).detail;
      setData((current) => updateGithubInSettingsData(current, github));
    };
    window.addEventListener(SETTINGS_GITHUB_CHANGED, handleGithubChange);
    return () => window.removeEventListener(SETTINGS_GITHUB_CHANGED, handleGithubChange);
  }, []);
  return (
    <>
      {feedback}
      <RepositoryAnalysisSection data={data} setData={setData} setFlashMessage={setMessage} />
    </>
  );
}

export function VercelIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const [data, setData] = useState(initialData);
  const { feedback, setMessage } = useIslandFeedback();
  return (
    <>
      {feedback}
      <SandboxProviderSection
        canManage={data.canManage}
        onSettingsChange={(settings) => {
          setData((current) => applySandboxSettingsToData(current, settings));
          dispatchSettingsEvent(SETTINGS_SANDBOX_CHANGED, settings);
        }}
        setFlashMessage={setMessage}
        settings={data.sandboxSettings}
        vercelConnection={data.vercelSandboxConnection}
        workspaceId={data.workspace.id}
      />
    </>
  );
}

export function LinearIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const [routing, setRouting] = useState(initialData.linearRouting);
  const [secrets, setSecrets] = useState(initialData.workspaceSecrets);
  const broadcastSecrets = useRef(false);
  const updateSecrets: Dispatch<SetStateAction<SecretsChangedDetail>> = (update) => {
    broadcastSecrets.current = true;
    setSecrets(update);
  };
  useEffect(() => {
    const handleSecretsChange = (event: Event) =>
      setSecrets((event as CustomEvent<SecretsChangedDetail>).detail);
    window.addEventListener(SETTINGS_SECRETS_CHANGED, handleSecretsChange);
    return () => window.removeEventListener(SETTINGS_SECRETS_CHANGED, handleSecretsChange);
  }, []);
  useEffect(() => {
    if (!broadcastSecrets.current) return;
    broadcastSecrets.current = false;
    dispatchSettingsEvent(SETTINGS_SECRETS_CHANGED, secrets);
  }, [secrets]);
  const linearSecret = secrets.find((secret) => secret.key === "LINEAR_API_KEY") ?? null;
  return (
    <LinearConfigurationSection
      canManage={initialData.canManage}
      isLoadingSecrets={false}
      linearSecret={linearSecret}
      onRoutingSaved={setRouting}
      routing={routing}
      setSecrets={updateSecrets}
      stages={initialData.pipeline?.stages ?? []}
      workspaceId={initialData.workspace.id}
    />
  );
}

export function RuntimeIntegrationIsland({
  codexStatus,
  initialData,
}: {
  codexStatus: string | null;
  initialData: SettingsPageData;
}) {
  const [secrets, setSecrets] = useState(initialData.workspaceSecrets);
  const broadcastSecrets = useRef(false);
  const updateSecrets: Dispatch<SetStateAction<SecretsChangedDetail>> = (update) => {
    broadcastSecrets.current = true;
    setSecrets(update);
  };
  const [sandboxData, setSandboxData] = useState(initialData);
  const { feedback, setMessage } = useIslandFeedback();
  useEffect(() => {
    const handleSandboxChange = (event: Event) =>
      setSandboxData((current) =>
        applySandboxSettingsToData(current, (event as CustomEvent<SandboxChangedDetail>).detail),
      );
    window.addEventListener(SETTINGS_SANDBOX_CHANGED, handleSandboxChange);
    return () => window.removeEventListener(SETTINGS_SANDBOX_CHANGED, handleSandboxChange);
  }, []);
  useEffect(() => {
    const handleSecretsChange = (event: Event) =>
      setSecrets((event as CustomEvent<SecretsChangedDetail>).detail);
    window.addEventListener(SETTINGS_SECRETS_CHANGED, handleSecretsChange);
    return () => window.removeEventListener(SETTINGS_SECRETS_CHANGED, handleSecretsChange);
  }, []);
  useEffect(() => {
    if (!broadcastSecrets.current) return;
    broadcastSecrets.current = false;
    dispatchSettingsEvent(SETTINGS_SECRETS_CHANGED, secrets);
  }, [secrets]);

  return (
    <>
      {feedback}
      <AgentConfigSection
        anchorId="runtime"
        canManage={initialData.canManage}
        codexConnectFlash={codexStatus}
        extraContent={
          <div className="space-y-4 border-t border-border pt-6">
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-foreground">Workspace secrets</h3>
              <p className="mt-1 text-xs leading-5 text-muted">
                Secret values never come back to the client. Wallie stores encrypted values and
                returns preview-only rows.
              </p>
            </div>
            <WorkspaceSecretsPanel
              canManage={initialData.canManage}
              isLoadingSecrets={false}
              secrets={secrets}
              setFlashMessage={setMessage}
              setSecrets={updateSecrets}
              workspaceId={initialData.workspace.id}
            />
          </div>
        }
        initialAgentConfig={initialData.agentConfig}
        initialClaudeCodeStatus={{
          checkedAt: initialData.setupHealth.claudeCodeConnection.checkedAt,
          connected: initialData.setupHealth.claudeCodeConnection.connected,
          updatedAt: initialData.setupHealth.claudeCodeConnection.updatedAt,
        }}
        initialCodexStatus={{
          accountEmail: initialData.setupHealth.codexConnection.accountEmail,
          checkedAt: initialData.setupHealth.codexConnection.checkedAt,
          connected: initialData.setupHealth.codexConnection.connected,
          credentialType: initialData.setupHealth.codexConnection.credentialType,
          expired: initialData.setupHealth.codexConnection.status === "expired",
          expiresAt: initialData.setupHealth.codexConnection.expiresAt,
          reconnectReason: initialData.setupHealth.codexConnection.reconnectReason,
          reconnectRequired: initialData.setupHealth.codexConnection.reconnectRequired,
          updatedAt: initialData.setupHealth.codexConnection.updatedAt,
        }}
        sandboxConnectionHref="#sandbox"
        sandboxConnectionLabel={
          sandboxData.setupHealth.sandboxConnection?.providerLabel ?? "a sandbox provider"
        }
        sandboxConnectionReady={
          sandboxData.setupHealth.sandboxConnection?.connected ??
          sandboxData.setupHealth.vercelSandboxConnection.connected
        }
        setFlashMessage={setMessage}
        tagline="Check coding-agent configuration, provider access, and workspace secrets used by Wallie runtime."
        title="Agent"
        vercelSandboxConnection={sandboxData.vercelSandboxConnection}
        workspaceId={initialData.workspace.id}
      />
    </>
  );
}
