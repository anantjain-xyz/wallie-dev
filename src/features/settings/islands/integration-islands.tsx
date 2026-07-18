"use client";

import { useState } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import { AgentConfigSection } from "@/features/settings/agent-config-section";
import { GitHubInstallSection } from "@/features/settings/github-install-section";
import { LinearConfigurationSection } from "@/features/settings/linear-configuration-section";
import { RepositoryAnalysisSection } from "@/features/settings/repository-analysis-section";
import { WorkspaceSecretsPanel } from "@/features/settings/secrets-section";
import { VercelSandboxConnectionSection } from "@/features/settings/vercel-sandbox-connection-section";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
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
  const initialMessage: FlashMessage | null =
    githubStatus === "connected"
      ? { kind: "success", text: "GitHub App installation connected and repositories synced." }
      : githubStatus
        ? { kind: "error", text: "GitHub installation could not be completed. Try again." }
        : null;
  const { feedback, setMessage } = useIslandFeedback(initialMessage);

  return (
    <>
      {feedback}
      <GitHubInstallSection
        canManage={canManage}
        github={github}
        onGithubChange={setGithub}
        setFlashMessage={setMessage}
        workspaceId={workspaceId}
      />
    </>
  );
}

export function RepositoryIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const [data, setData] = useState(initialData);
  const { feedback, setMessage } = useIslandFeedback();
  return (
    <>
      {feedback}
      <RepositoryAnalysisSection data={data} setData={setData} setFlashMessage={setMessage} />
    </>
  );
}

export function VercelIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const [connection, setConnection] = useState(initialData.vercelSandboxConnection);
  const { feedback, setMessage } = useIslandFeedback();
  return (
    <>
      {feedback}
      <VercelSandboxConnectionSection
        canManage={initialData.canManage}
        connection={connection}
        onConnectionChange={setConnection}
        setFlashMessage={setMessage}
        workspaceId={initialData.workspace.id}
      />
    </>
  );
}

export function LinearIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const [routing, setRouting] = useState(initialData.linearRouting);
  const [secrets, setSecrets] = useState(initialData.workspaceSecrets);
  const linearSecret = secrets.find((secret) => secret.key === "LINEAR_API_KEY") ?? null;
  return (
    <LinearConfigurationSection
      canManage={initialData.canManage}
      isLoadingSecrets={false}
      linearSecret={linearSecret}
      onRoutingSaved={setRouting}
      routing={routing}
      setSecrets={setSecrets}
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
  const { feedback, setMessage } = useIslandFeedback();

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
              setSecrets={setSecrets}
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
        setFlashMessage={setMessage}
        tagline="Check coding-agent configuration, provider access, and workspace secrets used by Wallie runtime."
        title="Agent"
        vercelSandboxConnection={initialData.vercelSandboxConnection}
        workspaceId={initialData.workspace.id}
      />
    </>
  );
}
