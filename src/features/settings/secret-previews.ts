import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";

export function upsertSecretPreview(
  currentSecrets: WorkspaceSecretPreview[],
  nextSecret: WorkspaceSecretPreview,
) {
  const nextSecrets = currentSecrets.filter((secret) => secret.key !== nextSecret.key);

  nextSecrets.push(nextSecret);
  nextSecrets.sort((left, right) => left.key.localeCompare(right.key));

  return nextSecrets;
}
