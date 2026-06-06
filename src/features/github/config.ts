import { parseServerEnv } from "@/env/server";

export const githubAppEnvKeys = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const;
export const githubAuthorEnvKeys = ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"] as const;
export const githubWebhookEnvKeys = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
] as const;

export function getMissingGitHubEnvKeys(
  keys: readonly string[],
  input: Record<string, string | undefined> = process.env,
) {
  return keys.filter((key) => !input[key]?.trim());
}

export function getGitHubConfigStatus(input: Record<string, string | undefined> = process.env) {
  return {
    missingAppKeys: getMissingGitHubEnvKeys(githubAppEnvKeys, input),
    missingAuthorKeys: getMissingGitHubEnvKeys(githubAuthorEnvKeys, input),
    missingWebhookKeys: getMissingGitHubEnvKeys(githubWebhookEnvKeys, input),
  };
}

function normalizePrivateKey(value: string) {
  return value.replace(/\\n/g, "\n");
}

export function resolveGitHubAppConfig(input: Record<string, string | undefined> = process.env) {
  const env = parseServerEnv(input);

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required.");
  }

  return {
    appId: Number(env.GITHUB_APP_ID),
    privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
  };
}

export function resolveGitHubWebhookSecret(
  input: Record<string, string | undefined> = process.env,
) {
  const env = parseServerEnv(input);

  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required.");
  }

  return env.GITHUB_WEBHOOK_SECRET;
}

export function resolveGitHubAuthorOAuthConfig(
  input: Record<string, string | undefined> = process.env,
) {
  const env = parseServerEnv(input);

  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are required.");
  }

  return {
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
  };
}
