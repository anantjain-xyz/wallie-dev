import type { SettingsPageData } from "@/features/settings/data";
import type { SandboxSettingsResponse } from "@/lib/sandbox-connections/contracts";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";

export const SETTINGS_GITHUB_CHANGED = "wallie:settings-github-changed";
export const SETTINGS_SANDBOX_CHANGED = "wallie:settings-sandbox-changed";
export const SETTINGS_SECRETS_CHANGED = "wallie:settings-secrets-changed";
export const SETTINGS_WORKSPACE_NAME_CHANGED = "wallie:settings-workspace-name-changed";

export function dispatchSettingsEvent<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export type GithubChangedDetail = SettingsPageData["github"];
export type SandboxChangedDetail = SandboxSettingsResponse;
export type SecretsChangedDetail = WorkspaceSecretPreview[];
