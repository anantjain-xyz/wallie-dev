import type { SettingsPageData } from "@/features/settings/data";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";

export const SETTINGS_GITHUB_CHANGED = "wallie:settings-github-changed";
export const SETTINGS_VERCEL_CHANGED = "wallie:settings-vercel-changed";
export const SETTINGS_SECRETS_CHANGED = "wallie:settings-secrets-changed";
export const SETTINGS_WORKSPACE_NAME_CHANGED = "wallie:settings-workspace-name-changed";

export type GithubChangedDetail = SettingsPageData["github"];
export type VercelChangedDetail = SettingsPageData["vercelSandboxConnection"];
export type SecretsChangedDetail = WorkspaceSecretPreview[];

let vercelConnectionSnapshot: VercelChangedDetail | undefined;
let secretsSnapshot: SecretsChangedDetail | undefined;

export function peekSettingsVercelConnection(fallback: VercelChangedDetail) {
  return vercelConnectionSnapshot !== undefined ? vercelConnectionSnapshot : fallback;
}

export function peekSettingsSecrets(fallback: SecretsChangedDetail) {
  return secretsSnapshot !== undefined ? secretsSnapshot : fallback;
}

/** Test-only: clear cross-category snapshots between cases. */
export function resetSettingsIslandSnapshotsForTests() {
  vercelConnectionSnapshot = undefined;
  secretsSnapshot = undefined;
}

export function dispatchSettingsEvent<T>(name: string, detail: T) {
  if (name === SETTINGS_VERCEL_CHANGED) {
    vercelConnectionSnapshot = detail as VercelChangedDetail;
  }
  if (name === SETTINGS_SECRETS_CHANGED) {
    secretsSnapshot = detail as SecretsChangedDetail;
  }
  window.dispatchEvent(new CustomEvent(name, { detail }));
}
