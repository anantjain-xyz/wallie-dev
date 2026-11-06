import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { resolveGitHubAppConfig } from "../src/features/github/config";

const requiredPermissions = [
  "actions",
  "administration",
  "checks",
  "contents",
  "metadata",
  "pull_requests",
  "statuses",
] as const;
const requiredEvents = [
  "check_run",
  "check_suite",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "push",
  "status",
] as const;

const argsSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
  repositoryId: z.coerce.number().int().positive().safe(),
  pr: z.coerce.number().int().positive().safe(),
  output: z.string().min(1),
});

type AuditRead = { status: number; outcome: string; count?: number };
let auditStage = "arguments";

/** This operational audit records codes/counts, never provider bodies or credentials. */
async function main() {
  const flags = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    const value = process.argv[i + 1];
    if (!flag?.startsWith("--") || !value || flags.has(flag)) throw new Error("invalid_args");
    flags.set(flag, value);
  }
  if (flags.size !== 4) throw new Error("invalid_args");
  const config = argsSchema.parse({
    repository: flags.get("--repository"),
    repositoryId: flags.get("--repository-id"),
    pr: flags.get("--pr"),
    output: flags.get("--output"),
  });
  const [owner, repo] = config.repository.split("/");
  auditStage = "app_config";
  const { App } = await import("@octokit/app");
  const app = new App(resolveGitHubAppConfig());
  const request = { signal: AbortSignal.timeout(20_000) };
  auditStage = "app_metadata";
  const { data: appMetadata } = await app.octokit.request("GET /app", { request });
  if (!appMetadata) throw new Error("app_unavailable");
  const appPermissions = appMetadata.permissions as Record<string, string | undefined>;
  const appEvents = appMetadata.events ?? [];
  auditStage = "repository_installation";
  const installationResponse = await app.octokit
    .request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
      request: { signal: AbortSignal.timeout(20_000) },
    })
    .catch(async (error: unknown) => {
      const status =
        error && typeof error === "object" && "status" in error && typeof error.status === "number"
          ? error.status
          : undefined;
      if (![403, 404].includes(status ?? 0)) throw error;
      const audit = {
        issue: "OP-506",
        observedAt: new Date().toISOString(),
        repository: config.repository,
        repositoryId: config.repositoryId,
        prNumber: config.pr,
        app: { id: appMetadata.id, name: appMetadata.name, slug: appMetadata.slug },
        appPermissions,
        appEvents,
        missingAppPermissions: requiredPermissions.filter(
          (name) => !["read", "write"].includes(appPermissions[name] ?? ""),
        ),
        missingAppEvents: requiredEvents.filter((event) => !appEvents.includes(event)),
        installationAccess: { status, outcome: "unavailable" },
        installationPermissions: "unknown",
        scope: null,
        reads: {},
        limitations: [
          "The configured App cannot resolve an installation for this repository; no token was minted.",
          "This local App audit does not establish production App configuration.",
          "No settings, branches, PRs, checks, or repositories were changed.",
        ],
      };
      await writeFile(resolve(config.output), `${JSON.stringify(audit, null, 2)}\n`);
      console.log(
        JSON.stringify({
          output: config.output,
          stage: auditStage,
          status,
          missingAppPermissions: audit.missingAppPermissions,
          missingAppEvents: audit.missingAppEvents,
        }),
      );
      process.exitCode = 1;
      return null;
    });
  if (!installationResponse) return;
  const { data: installation } = installationResponse;
  if (installation.suspended_at) throw new Error("installation_suspended");
  const granted = installation.permissions as Record<string, string | undefined>;
  const permissions: Record<string, "read"> = {};
  for (const name of requiredPermissions) {
    if (granted[name] === "read" || granted[name] === "write") permissions[name] = "read";
  }
  auditStage = "scoped_token";
  const { data: credential } = await app.octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installation.id,
      repository_ids: [config.repositoryId],
      permissions,
      request: { signal: AbortSignal.timeout(20_000) },
    },
  );
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const read = async (path: string, graphql?: { query: string; variables: object }) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method: graphql ? "POST" : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(graphql ? { "Content-Type": "application/json" } : {}),
      },
      ...(graphql ? { body: JSON.stringify(graphql) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, data: undefined };
    }
    return { status: response.status, data: (await response.json()) as unknown };
  };
  auditStage = "repository_identity";
  const repository = await read(prefix);
  const identity = z.object({ id: z.number(), full_name: z.string() }).parse(repository.data);
  if (
    identity.id !== config.repositoryId ||
    identity.full_name.toLowerCase() !== config.repository.toLowerCase()
  )
    throw new Error("repository_identity_mismatch");
  auditStage = "pull_request_identity";
  const pull = await read(`${prefix}/pulls/${config.pr}`);
  const pr = z
    .object({
      number: z.number(),
      state: z.enum(["open", "closed"]),
      merged: z.boolean(),
      head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
      base: z.object({
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        ref: z.string(),
        repo: z.object({ id: z.number() }),
      }),
    })
    .parse(pull.data);
  if (pr.number !== config.pr || pr.base.repo.id !== config.repositoryId)
    throw new Error("pull_request_identity_mismatch");

  const reads: Record<string, AuditRead> = {
    repository: { status: repository.status, outcome: "identity_verified" },
    pullRequest: { status: pull.status, outcome: pr.merged ? "merged" : pr.state },
  };
  const probes = [
    ["branchProtection", `${prefix}/branches/${encodeURIComponent(pr.base.ref)}/protection`],
    ["applicableRules", `${prefix}/rules/branches/${encodeURIComponent(pr.base.ref)}?per_page=1`],
    ["headChecks", `${prefix}/commits/${pr.head.sha}/check-runs?per_page=1`],
    ["headStatuses", `${prefix}/commits/${pr.head.sha}/statuses?per_page=1`],
    ["reviews", `${prefix}/pulls/${config.pr}/reviews?per_page=1`],
    ["workflowRuns", `${prefix}/actions/runs?head_sha=${pr.head.sha}&per_page=1`],
  ] as const;
  for (const [name, path] of probes) {
    auditStage = name;
    const result = await read(path);
    const body = result.data as { total_count?: number } | undefined;
    reads[name] = {
      status: result.status,
      outcome:
        result.status === 200
          ? "read_available"
          : name === "branchProtection" && result.status === 404 && permissions.administration
            ? "no_classic_protection"
            : "unavailable",
      ...(typeof body?.total_count === "number"
        ? { count: body.total_count }
        : Array.isArray(result.data)
          ? { count: result.data.length }
          : {}),
    };
  }
  auditStage = "review_threads_graphql";
  const graph = await read("/graphql", {
    query: `query Audit($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){databaseId pullRequest(number:$number){number headRefOid baseRefOid mergeable reviewDecision reviewThreads(first:1){totalCount}}}}`,
    variables: { owner, repo, number: config.pr },
  });
  const graphResult = z
    .object({
      errors: z.array(z.unknown()).optional(),
      data: z
        .object({
          repository: z.object({
            databaseId: z.number(),
            pullRequest: z.object({
              number: z.number(),
              headRefOid: z.string(),
              baseRefOid: z.string(),
              reviewThreads: z.object({ totalCount: z.number() }),
            }),
          }),
        })
        .optional(),
    })
    .safeParse(graph.data);
  const graphPr = graphResult.success ? graphResult.data.data?.repository.pullRequest : undefined;
  const graphValid =
    graphResult.success &&
    !graphResult.data.errors?.length &&
    graphResult.data.data?.repository.databaseId === config.repositoryId &&
    graphPr?.number === config.pr &&
    graphPr.headRefOid === pr.head.sha &&
    graphPr.baseRefOid === pr.base.sha;
  reads.reviewThreadsGraphql = {
    status: graph.status,
    outcome: graphValid ? "identity_verified" : "unavailable_or_identity_changed",
    ...(graphValid ? { count: graphPr!.reviewThreads.totalCount } : {}),
  };
  const installationEvents = installation.events ?? [];
  const audit = {
    issue: "OP-506",
    observedAt: new Date().toISOString(),
    repository: config.repository,
    repositoryId: config.repositoryId,
    prNumber: config.pr,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    app: { id: appMetadata.id, name: appMetadata.name, slug: appMetadata.slug },
    appEvents,
    installationEvents,
    installationId: installation.id,
    scope: { repositoryIds: [config.repositoryId], requestedPermissions: permissions },
    permissions: requiredPermissions.map((name) => ({
      name,
      app: appPermissions[name] ?? "none",
      installation: granted[name] ?? "none",
    })),
    missingPermissions: requiredPermissions.filter((name) => !permissions[name]),
    requiredEvents,
    missingAppEvents: requiredEvents.filter((event) => !appEvents.includes(event)),
    missingInstallationEvents: requiredEvents.filter(
      (event) => !installationEvents.includes(event),
    ),
    reads,
    limitations: [
      "Read-only audit of one existing PR, not end-to-end delivery qualification.",
      "List endpoint probes use one page to verify access; counts are not a readiness decision.",
      "No webhook was sent and no settings, branches, PRs, checks, or repositories were changed.",
    ],
  };
  auditStage = "write_evidence";
  await writeFile(resolve(config.output), `${JSON.stringify(audit, null, 2)}\n`);
  console.log(
    JSON.stringify({
      output: config.output,
      missingPermissions: audit.missingPermissions,
      missingAppEvents: audit.missingAppEvents,
      missingInstallationEvents: audit.missingInstallationEvents,
      reads,
    }),
  );
}

void main().catch((error: unknown) => {
  const status =
    error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  console.error(
    JSON.stringify({ error: "github_verification_audit_failed", stage: auditStage, status }),
  );
  process.exitCode = 1;
});
