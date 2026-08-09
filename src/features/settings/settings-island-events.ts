import type { SetStateAction } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import type { SandboxSettingsResponse } from "@/lib/sandbox-connections/contracts";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";

export const SETTINGS_GITHUB_CHANGED = "wallie:settings-github-changed";
export const SETTINGS_DATA_CHANGED = "wallie:settings-data-changed";
export const SETTINGS_PIPELINE_CHANGED = "wallie:settings-pipeline-changed";
export const SETTINGS_SANDBOX_CHANGED = "wallie:settings-sandbox-changed";
export const SETTINGS_SECRETS_CHANGED = "wallie:settings-secrets-changed";
export const SETTINGS_WORKSPACE_NAME_CHANGED = "wallie:settings-workspace-name-changed";

export type SettingsDataUpdate = SetStateAction<SettingsPageData>;
export type SettingsDataChangedDetail = {
  update: SettingsDataUpdate;
  workspaceId: string;
};

export type SettingsDataReplayConsumer = "repository" | "verify-setup";

type SettingsDataChangeRecord = {
  pendingConsumers: Set<SettingsDataReplayConsumer>;
  update: SettingsDataUpdate;
};

const SETTINGS_DATA_REPLAY_CONSUMERS: SettingsDataReplayConsumer[] = ["repository", "verify-setup"];
const activeSettingsDataConsumers = new Map<string, Set<SettingsDataReplayConsumer>>();
const settingsDataChangeHistory = new Map<string, SettingsDataChangeRecord[]>();

export function dispatchSettingsEvent<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function dispatchSettingsDataChanged(workspaceId: string, update: SettingsDataUpdate) {
  const activeConsumers = activeSettingsDataConsumers.get(workspaceId);
  const pendingConsumers = new Set(
    SETTINGS_DATA_REPLAY_CONSUMERS.filter((consumer) => !activeConsumers?.has(consumer)),
  );
  if (pendingConsumers.size > 0) {
    const history = settingsDataChangeHistory.get(workspaceId) ?? [];
    history.push({ pendingConsumers, update });
    settingsDataChangeHistory.set(workspaceId, history);
  }
  dispatchSettingsEvent(SETTINGS_DATA_CHANGED, { update, workspaceId });
}

export function replaySettingsDataChanges(
  initialData: SettingsPageData,
  consumer: SettingsDataReplayConsumer,
): SettingsPageData {
  let current = initialData;
  for (const { pendingConsumers, update } of settingsDataChangeHistory.get(
    initialData.workspace.id,
  ) ?? []) {
    if (!pendingConsumers.has(consumer)) continue;
    current = typeof update === "function" ? update(current) : update;
  }
  return current;
}

export function registerSettingsDataReplayConsumer(
  workspaceId: string,
  consumer: SettingsDataReplayConsumer,
) {
  const activeConsumers = activeSettingsDataConsumers.get(workspaceId) ?? new Set();
  activeConsumers.add(consumer);
  activeSettingsDataConsumers.set(workspaceId, activeConsumers);

  const history = settingsDataChangeHistory.get(workspaceId);
  if (history) {
    for (const record of history) record.pendingConsumers.delete(consumer);
    const pendingHistory = history.filter((record) => record.pendingConsumers.size > 0);
    if (pendingHistory.length > 0) settingsDataChangeHistory.set(workspaceId, pendingHistory);
    else settingsDataChangeHistory.delete(workspaceId);
  }

  return () => {
    const currentConsumers = activeSettingsDataConsumers.get(workspaceId);
    currentConsumers?.delete(consumer);
    if (currentConsumers?.size === 0) activeSettingsDataConsumers.delete(workspaceId);
  };
}

export type GithubChangedDetail = SettingsPageData["github"];
export type PipelineChangedDetail = NonNullable<SettingsPageData["pipeline"]>;
export type SandboxChangedDetail = SandboxSettingsResponse;
export type SecretsChangedDetail = WorkspaceSecretPreview[];
