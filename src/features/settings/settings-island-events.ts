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

const settingsDataChangeHistory = new Map<string, SettingsDataUpdate[]>();

export function dispatchSettingsEvent<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function dispatchSettingsDataChanged(workspaceId: string, update: SettingsDataUpdate) {
  const history = settingsDataChangeHistory.get(workspaceId) ?? [];
  history.push(update);
  settingsDataChangeHistory.set(workspaceId, history);
  dispatchSettingsEvent(SETTINGS_DATA_CHANGED, { update, workspaceId });
}

export function replaySettingsDataChanges(initialData: SettingsPageData): SettingsPageData {
  let current = initialData;
  for (const update of settingsDataChangeHistory.get(initialData.workspace.id) ?? []) {
    current = typeof update === "function" ? update(current) : update;
  }
  return current;
}

export type GithubChangedDetail = SettingsPageData["github"];
export type PipelineChangedDetail = NonNullable<SettingsPageData["pipeline"]>;
export type SandboxChangedDetail = SandboxSettingsResponse;
export type SecretsChangedDetail = WorkspaceSecretPreview[];
