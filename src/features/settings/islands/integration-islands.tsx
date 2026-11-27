"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import { AgentConfigSection } from "@/features/settings/agent-config-section";
import { FactorySettingsForm, useFactorySettings } from "@/features/settings/factory-settings";
import { FactorySandboxProviderSettings } from "@/features/settings/factory-sandbox-provider-settings";
import { ExecutionPolicySection } from "@/features/settings/execution-policy-section";
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
import { Section } from "@/features/settings/settings-ui";
import {
  updateAgentConfigInSettingsData,
  updateCursorConnectionInSettingsData,
  updateGithubInSettingsData,
  updateLinearRoutingInSettingsData,
  updateSecretsInSettingsData,
} from "@/features/settings/settings-data-updates";
import {
  dispatchSettingsDataChanged,
  dispatchSettingsEvent,
  registerSettingsDataReplayConsumer,
  replaySettingsDataChanges,
  subscribeToSettingsSandboxChanges,
  SETTINGS_GITHUB_CHANGED,
  SETTINGS_PIPELINE_CHANGED,
  SETTINGS_SANDBOX_CHANGED,
  SETTINGS_SECRETS_CHANGED,
  type GithubChangedDetail,
  type PipelineChangedDetail,
  type SandboxChangedDetail,
  type SecretsChangedDetail,
} from "@/features/settings/settings-island-events";

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
          text: "GitHub installed. Missing server configuration prevents sync.",
        };
      case "invalid_state":
        return {
          kind: "error",
          text: "GitHub installation expired or unverified. Restart installation in Settings.",
        };
      case "failed":
        return {
          kind: "error",
          text: "GitHub installation failed. Check server configuration and retry.",
        };
      default:
        return null;
    }
  })();
  const { feedback, setMessage } = useIslandFeedback(initialMessage);

  return (
    <GitHubInstallSection
      canManage={canManage}
      feedback={feedback}
      github={github}
      onGithubChange={(nextGithub) => {
        setGithub(nextGithub);
        dispatchSettingsEvent(SETTINGS_GITHUB_CHANGED, nextGithub);
        dispatchSettingsDataChanged(workspaceId, (current: SettingsPageData) =>
          updateGithubInSettingsData(current, nextGithub),
        );
      }}
      setFlashMessage={setMessage}
      workspaceId={workspaceId}
    />
  );
}

export function RepositoryIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const [data, setData] = useState(() => replaySettingsDataChanges(initialData, "repository"));
  const { feedback, setMessage } = useIslandFeedback();
  const updateData: Dispatch<SetStateAction<SettingsPageData>> = (update) => {
    setData(update);
    dispatchSettingsDataChanged(initialData.workspace.id, update);
  };
  useEffect(() => {
    return registerSettingsDataReplayConsumer(initialData.workspace.id, "repository");
  }, [initialData.workspace.id]);
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
      <RepositoryAnalysisSection data={data} setData={updateData} setFlashMessage={setMessage} />
    </>
  );
}

export function VercelIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const [data, setData] = useState(initialData);
  const workspaceId = data.workspace.id;
  const { feedback, setMessage } = useIslandFeedback();
  return (
    <>
      {feedback}
      <SandboxProviderSection
        canManage={data.canManage}
        onSettingsChange={(settings) => {
          setData((current) => applySandboxSettingsToData(current, settings));
          dispatchSettingsEvent<SandboxChangedDetail>(SETTINGS_SANDBOX_CHANGED, {
            settings,
            workspaceId,
          });
          dispatchSettingsDataChanged(workspaceId, (current: SettingsPageData) =>
            applySandboxSettingsToData(current, settings),
          );
        }}
        setFlashMessage={setMessage}
        settings={data.sandboxSettings}
        vercelConnection={data.vercelSandboxConnection}
        workspaceId={workspaceId}
      />
    </>
  );
}

export function LinearIntegrationIsland({ initialData }: { initialData: SettingsPageData }) {
  const factory = useFactorySettings();
  const published = factory?.snapshot?.published;
  const [pipeline, setPipeline] = useState(initialData.pipeline);
  const [routing, setRouting] = useState(initialData.linearRouting);
  const [secrets, setSecrets] = useState(initialData.workspaceSecrets);
  const broadcastSecrets = useRef(false);
  const updateSecrets: Dispatch<SetStateAction<SecretsChangedDetail>> = (update) => {
    broadcastSecrets.current = true;
    setSecrets(update);
  };
  useEffect(() => {
    const handlePipelineChange = (event: Event) =>
      setPipeline((event as CustomEvent<PipelineChangedDetail>).detail);
    window.addEventListener(SETTINGS_PIPELINE_CHANGED, handlePipelineChange);
    return () => window.removeEventListener(SETTINGS_PIPELINE_CHANGED, handlePipelineChange);
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
    dispatchSettingsDataChanged(initialData.workspace.id, (current: SettingsPageData) =>
      updateSecretsInSettingsData(current, secrets),
    );
  }, [initialData.workspace.id, secrets]);
  const linearSecret = secrets.find((secret) => secret.key === "LINEAR_API_KEY") ?? null;
  const liveStages = pipeline?.stages ?? [];
  const stages = factory?.snapshot?.published ? factory.snapshot.publishedStages : liveStages;

  function publishedSlug(id: string | undefined, slug: string | null) {
    if (!published || !slug) return slug;
    const stableId = id ?? liveStages.find((stage) => stage.slug === slug)?.id;
    if (!stableId) return slug;
    return stages.find((stage) => stage.id === stableId)?.slug ?? "(unavailable)";
  }
  return (
    <LinearConfigurationSection
      canManage={initialData.canManage}
      factoryRevisionId={factory?.snapshot ? (published?.id ?? null) : undefined}
      loadingStages={factory?.phase === "loading" || factory?.phase === "error"}
      isLoadingSecrets={false}
      linearSecret={linearSecret}
      onRoutingSaved={(nextRouting) => {
        setRouting(nextRouting);
        dispatchSettingsDataChanged(initialData.workspace.id, (current: SettingsPageData) =>
          updateLinearRoutingInSettingsData(current, nextRouting),
        );
      }}
      routing={{
        ...routing,
        landStageSlug: publishedSlug(routing.landStageId, routing.landStageSlug),
        reworkStageSlug: publishedSlug(routing.reworkStageId, routing.reworkStageSlug) ?? "",
      }}
      setSecrets={updateSecrets}
      stages={stages}
      workspaceId={initialData.workspace.id}
    />
  );
}

export function WorkspaceSecretsIntegrationIsland({
  initialData,
}: {
  initialData: SettingsPageData;
}) {
  const [secrets, setSecrets] = useState(initialData.workspaceSecrets);
  const broadcastSecrets = useRef(false);
  const updateSecrets: Dispatch<SetStateAction<SecretsChangedDetail>> = (update) => {
    broadcastSecrets.current = true;
    setSecrets(update);
  };
  const { feedback, setMessage } = useIslandFeedback();
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
    dispatchSettingsDataChanged(initialData.workspace.id, (current: SettingsPageData) =>
      updateSecretsInSettingsData(current, secrets),
    );
  }, [initialData.workspace.id, secrets]);

  return (
    <Section
      anchorId="workspace-secrets"
      heading="h3"
      tagline={`Secrets stored here belong to ${initialData.workspace.name}. Wallie encrypts secret values and shows previews only.`}
      title="Workspace secrets"
    >
      {feedback}
      <WorkspaceSecretsPanel
        canManage={initialData.canManage}
        isLoadingSecrets={false}
        secrets={secrets}
        setFlashMessage={setMessage}
        setSecrets={updateSecrets}
        workspaceId={initialData.workspace.id}
      />
    </Section>
  );
}

export function RuntimeIntegrationIsland({
  defaultFactoryName,
  initialData,
}: {
  defaultFactoryName?: string;
  initialData: SettingsPageData;
}) {
  const [sandboxData, setSandboxData] = useState(initialData);
  const { feedback, setMessage } = useIslandFeedback();
  useEffect(
    () =>
      subscribeToSettingsSandboxChanges(initialData, (settings) =>
        setSandboxData((current) => applySandboxSettingsToData(current, settings)),
      ),
    [initialData],
  );

  return (
    <>
      {feedback}
      <AgentConfigSection
        anchorId="runtime"
        canManage={initialData.canManage}
        defaultFactoryName={defaultFactoryName}
        extraContent={
          <>
            {initialData.canManage ? (
              <FactorySettingsForm section="sandboxProvider">
                {(revision) =>
                  revision ? (
                    <FactorySandboxProviderSettings
                      revision={revision}
                      settings={sandboxData.sandboxSettings}
                    />
                  ) : null
                }
              </FactorySettingsForm>
            ) : null}
            <ExecutionPolicySection
              canManage={initialData.canManage}
              workspaceId={initialData.workspace.id}
            />
          </>
        }
        initialAgentConfig={initialData.agentConfig}
        initialCursorStatus={
          initialData.setupHealth.cursorConnection
            ? {
                accountEmail: initialData.setupHealth.cursorConnection.accountEmail,
                checkedAt: initialData.setupHealth.cursorConnection.checkedAt,
                connected: initialData.setupHealth.cursorConnection.connected,
                expired: initialData.setupHealth.cursorConnection.status === "expired",
                expiresAt: initialData.setupHealth.cursorConnection.expiresAt,
                reconnectReason: initialData.setupHealth.cursorConnection.reconnectReason,
                reconnectRequired: initialData.setupHealth.cursorConnection.reconnectRequired,
                updatedAt: initialData.setupHealth.cursorConnection.updatedAt,
              }
            : undefined
        }
        onAgentConfigSaved={(entries) =>
          dispatchSettingsDataChanged(initialData.workspace.id, (current: SettingsPageData) =>
            updateAgentConfigInSettingsData(current, entries),
          )
        }
        onCursorStatusChange={(status) =>
          dispatchSettingsDataChanged(initialData.workspace.id, (current: SettingsPageData) =>
            updateCursorConnectionInSettingsData(current, status),
          )
        }
        setFlashMessage={setMessage}
        title="Agent runtime"
        workspaceId={initialData.workspace.id}
        workspaceSlug={initialData.workspace.slug}
      />
    </>
  );
}
