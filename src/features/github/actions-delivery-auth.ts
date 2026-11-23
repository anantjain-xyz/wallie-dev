import "server-only";

import { z } from "zod/v4";

import {
  actionsNumericId,
  type ActionsDeliveryReason,
} from "@/lib/factory-delivery-commands/actions-contract";

import { resolveGitHubAppConfig } from "./config";

type AuthReason = Extract<
  ActionsDeliveryReason,
  "app_unavailable" | "installation_unavailable" | "permission_missing" | "github_unavailable"
>;
type InstallationCredential =
  | { kind: "granted"; token: string; actorLogin: string }
  | { kind: "blocked"; reason: AuthReason };
const installation = z.object({
  id: actionsNumericId,
  app_slug: z.string().regex(/^[a-zA-Z0-9-]+$/),
  suspended_at: z.string().nullable(),
  permissions: z.object({ actions: z.string().optional(), contents: z.string().optional() }),
});
const installationToken = z.object({
  token: z.string().min(1),
  permissions: installation.shape.permissions,
});

export async function mintActionsDeliveryToken(input: {
  installationId: number;
  repositoryNumericId: number;
  mode: "dispatch" | "observe";
  signal: AbortSignal;
  environment?: Record<string, string | undefined>;
}): Promise<InstallationCredential> {
  if (
    !actionsNumericId.safeParse(input.installationId).success ||
    !actionsNumericId.safeParse(input.repositoryNumericId).success
  )
    return { kind: "blocked", reason: "installation_unavailable" };
  if (input.signal.aborted) return { kind: "blocked", reason: "github_unavailable" };
  let config: ReturnType<typeof resolveGitHubAppConfig>;
  try {
    config = resolveGitHubAppConfig(input.environment);
  } catch {
    return { kind: "blocked", reason: "app_unavailable" };
  }

  try {
    const { App } = await import("@octokit/app");
    const app = new App(config);
    const request = { signal: input.signal, redirect: "manual" as const };
    const target = await app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: input.installationId,
      request,
    });
    const access = installation.parse(target.data);
    if (access.id !== input.installationId || access.suspended_at !== null)
      return { kind: "blocked", reason: "installation_unavailable" };

    const actions = input.mode === "dispatch" ? "write" : "read";
    const canUse = (granted: string | undefined, required: "write" | "read") =>
      granted === "write" || (required === "read" && granted === "read");
    if (
      !canUse(access.permissions.actions, actions) ||
      !canUse(access.permissions.contents, "read")
    )
      return { kind: "blocked", reason: "permission_missing" };

    const result = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: input.installationId,
        repository_ids: [input.repositoryNumericId],
        permissions: { actions, contents: "read" },
        request,
      },
    );
    const scoped = installationToken.parse(result.data);
    if (scoped.permissions.actions !== actions || scoped.permissions.contents !== "read")
      return { kind: "blocked", reason: "permission_missing" };
    input.signal.throwIfAborted();
    return { kind: "granted", token: scoped.token, actorLogin: `${access.app_slug}[bot]` };
  } catch (error) {
    const failure = z
      .object({
        status: z.number().optional(),
        response: z
          .object({ headers: z.record(z.string(), z.union([z.string(), z.number()])) })
          .optional(),
      })
      .safeParse(error);
    const status = failure.data?.status;
    const headers = failure.data?.response?.headers;
    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (String(headers?.["x-ratelimit-remaining"]) === "0" ||
          headers?.["retry-after"] !== undefined));
    if (rateLimited) return { kind: "blocked", reason: "github_unavailable" };
    return {
      kind: "blocked",
      reason:
        status === 401 || status === 404 || status === 422
          ? "installation_unavailable"
          : status === 403
            ? "permission_missing"
            : "github_unavailable",
    };
  }
}
