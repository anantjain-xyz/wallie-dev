import type { SettingsPageData } from "@/features/settings/data";

export const SETTINGS_GITHUB_CHANGED = "wallie:settings-github-changed";
export const SETTINGS_VERCEL_CHANGED = "wallie:settings-vercel-changed";
export const SETTINGS_WORKSPACE_NAME_CHANGED = "wallie:settings-workspace-name-changed";

export function dispatchSettingsEvent<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export type GithubChangedDetail = SettingsPageData["github"];
export type VercelChangedDetail = SettingsPageData["vercelSandboxConnection"];
