import "server-only";

import { z } from "zod";

import { resolveGitHubAppConfig } from "./config";

const installationSchema = z.object({
  id: z.number().int().positive().safe(),
  suspended_at: z.string().nullable(),
  permissions: z.record(z.string()),
});

const READ_PERMISSIONS = [
  "contents",
  "pull_requests",
  "checks",
  "statuses",
  "administration",
  "actions",
  "metadata",
] as const;

export class PrVerificationAuthError extends Error {
  constructor(
    readonly code:
      | "github_app_config_unavailable"
      | "github_installation_unavailable"
      | "github_permission_missing"
      | "github_rate_limited"
      | "github_auth_unavailable",
  ) {
    super("GitHub verification access could not be confirmed.");
  }
}

/** Mint a read-only credential for exactly the pinned numeric repository. */
export async function mintPrVerificationToken(input: {
  installationId: number;
  repositoryNumericId: number;
  signal: AbortSignal;
  environment?: Record<string, string | undefined>;
}) {
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0 ||
    !Number.isSafeInteger(input.repositoryNumericId) ||
    input.repositoryNumericId <= 0
  )
    throw new Error("Invalid GitHub verification identity.");
  input.signal.throwIfAborted();
  const { App } = await import("@octokit/app");
  let config: ReturnType<typeof resolveGitHubAppConfig>;
  try {
    config = resolveGitHubAppConfig(input.environment);
  } catch {
    throw new PrVerificationAuthError("github_app_config_unavailable");
  }
  const app = new App(config);
  const request = { signal: input.signal, timeout: 10_000, redirect: "manual" as const };
  const safeRequest = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      const failure = error as {
        status?: number;
        response?: { headers?: Record<string, string | number | undefined> };
      };
      const status = failure.status;
      const headers = failure.response?.headers;
      throw new PrVerificationAuthError(
        status === 429 ||
          (status === 403 &&
            (String(headers?.["x-ratelimit-remaining"]) === "0" ||
              headers?.["retry-after"] !== undefined))
          ? "github_rate_limited"
          : status === 401 || status === 404
            ? "github_installation_unavailable"
            : status === 403
              ? "github_permission_missing"
              : "github_auth_unavailable",
      );
    }
  };
  const { data } = await safeRequest(() =>
    app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: input.installationId,
      request,
    }),
  );
  const installation = installationSchema.parse(data);
  if (installation.id !== input.installationId || installation.suspended_at !== null)
    throw new PrVerificationAuthError("github_installation_unavailable");
  const permissions: Partial<Record<(typeof READ_PERMISSIONS)[number], "read">> = {};
  for (const name of READ_PERMISSIONS) {
    if (["read", "write", "admin"].includes(installation.permissions[name]))
      permissions[name] = "read";
  }
  // Missing permissions remain absent and are reported by the collector. Never
  // request a larger grant or fall back to an installation-wide credential.
  const response = await safeRequest(() =>
    app.octokit.request("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: input.installationId,
      repository_ids: [input.repositoryNumericId],
      permissions,
      request,
    }),
  );
  input.signal.throwIfAborted();
  const token = z.string().min(1).parse(response.data.token);
  return { token, installationPermissions: installation.permissions };
}
