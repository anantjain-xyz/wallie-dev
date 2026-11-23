import "server-only";

import { parse } from "yaml";
import { z } from "zod/v4";

import {
  actionsNumericId,
  actionsRunConclusion,
  actionsRunStatus,
  type ActionsDeliveryObservation,
  type ActionsDeliveryOperation,
  type ActionsDeliveryReason,
} from "@/lib/factory-delivery-commands/actions-contract";

import { mintActionsDeliveryToken } from "./actions-delivery-auth";

const apiVersion = "2026-03-10";
const reservedInputs = [
  "wallie_command_id",
  "wallie_source_sha",
  "wallie_environment",
  "wallie_run_nonce",
] as const;
const repositorySchema = z.object({ id: actionsNumericId, full_name: z.string() });
const workflowSchema = z.object({ id: actionsNumericId, path: z.string(), state: z.string() });
const immutableReleaseSchema = z.object({
  tag_name: z.string(),
  immutable: z.literal(true),
  draft: z.literal(false),
  published_at: z.iso.datetime({ offset: true }),
});
const gitObjectSchema = z.object({
  type: z.enum(["commit", "tag"]),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
});
const referenceSchema = z.object({ ref: z.string(), object: gitObjectSchema });
const annotatedTagSchema = z.object({ sha: gitObjectSchema.shape.sha, object: gitObjectSchema });
const fileSchema = z.object({
  type: z.literal("file"),
  path: z.string(),
  encoding: z.literal("base64"),
  size: z.number().int().min(1).max(32_768),
  content: z.string().max(50_000),
});
const workflowInput = z.object({ type: z.string(), required: z.boolean().optional() });
const dispatchWorkflowSchema = z.object({
  "run-name": z.string().regex(/^wallie:\$\{\{\s*inputs\.wallie_run_nonce\s*\}\}$/),
  on: z.object({ workflow_dispatch: z.object({ inputs: z.record(z.string(), workflowInput) }) }),
});
const dispatchResponse = z.object({ workflow_run_id: actionsNumericId });
const runSchema = z.object({
  id: actionsNumericId,
  workflow_id: actionsNumericId,
  repository: z.object({ id: actionsNumericId }),
  head_repository: z.object({ id: actionsNumericId }),
  head_branch: z.string(),
  head_sha: gitObjectSchema.shape.sha,
  path: z.string(),
  event: z.literal("workflow_dispatch"),
  display_title: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  run_attempt: z.literal(1),
  actor: z.object({ login: z.string() }),
  status: actionsRunStatus,
  conclusion: actionsRunConclusion.nullable(),
});

export type ActionsDispatchResult =
  | { kind: "accepted"; runId: number }
  | { kind: "unknown" }
  | { kind: "rejected"; reason: ActionsDeliveryReason };

export type ActionsObservationResult =
  | {
      kind: "observed";
      runId: number;
      status: z.infer<typeof actionsRunStatus>;
      conclusion: z.infer<typeof actionsRunConclusion> | null;
    }
  | { kind: "unverified"; reason: ActionsDeliveryReason };

type ProviderOptions = {
  signal: AbortSignal;
  fetcher?: typeof fetch;
  mintToken?: typeof mintActionsDeliveryToken;
};

class GitHubRequestError extends Error {
  constructor(readonly response: Response) {
    super("GitHub denied the configured workflow request.");
  }
}

function isDefinitiveResponse(response: Response) {
  if (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0")
    return false;
  return [400, 401, 403, 404, 410, 422].includes(response.status);
}

function repositoryRequest(
  target: ActionsDeliveryOperation,
  credential: string,
  options: ProviderOptions,
) {
  const base = `https://api.github.com/repos/${target.repositoryFullName}`;
  const send = options.fetcher ?? fetch;
  return async (path: string, payload?: Record<string, unknown>) => {
    options.signal.throwIfAborted();
    const response = await send(`${base}${path}`, {
      method: payload ? "POST" : "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "wallie-delivery",
        "content-type": "application/json",
        "x-github-api-version": apiVersion,
        authorization: `Bearer ${credential}`,
      },
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok) throw new GitHubRequestError(response);
    const data: unknown = await response.json();
    return data;
  };
}

type RepositoryRequest = ReturnType<typeof repositoryRequest>;

async function readGitHubResource(get: RepositoryRequest, path: string) {
  try {
    return await get(path);
  } catch (error) {
    if (
      error instanceof GitHubRequestError &&
      error.response.status === 404 &&
      isDefinitiveResponse(error.response)
    )
      return null;
    throw error;
  }
}

async function checkDispatchTarget(
  target: ActionsDeliveryOperation,
  request: RepositoryRequest,
): Promise<ActionsDeliveryReason | null> {
  const [repository, workflow, release, workflowFile] = await Promise.all([
    readGitHubResource(request, ""),
    readGitHubResource(request, `/actions/workflows/${target.workflowId}`),
    readGitHubResource(request, `/releases/tags/${encodeURIComponent(target.tag)}`),
    readGitHubResource(request, `/contents/${target.workflowPath}?ref=${target.sourceRevision}`),
  ]);
  const repo = repositorySchema.safeParse(repository);
  if (
    !repo.success ||
    repo.data.id !== target.repositoryNumericId ||
    repo.data.full_name.toLowerCase() !== target.repositoryFullName.toLowerCase()
  )
    return "repository_unavailable";

  const active = workflowSchema.safeParse(workflow);
  if (
    !active.success ||
    active.data.id !== target.workflowId ||
    active.data.path !== target.workflowPath ||
    active.data.state !== "active"
  )
    return "workflow_unavailable";

  const immutable = immutableReleaseSchema.safeParse(release);
  if (!immutable.success || immutable.data.tag_name !== target.tag) return "immutable_tag_required";

  // Resolve the tag after observing immutability. A parallel lookup could see the
  // old mutable ref while publication locks a different commit.
  const encodedTag = target.tag.split("/").map(encodeURIComponent).join("/");
  const reference = await readGitHubResource(request, `/git/ref/tags/${encodedTag}`);
  const ref = referenceSchema.safeParse(reference);
  if (!ref.success || ref.data.ref !== `refs/tags/${target.tag}`) return "immutable_tag_required";

  let object = ref.data.object;
  for (let count = 0; object.type === "tag" && count < 3; count++) {
    const tagged = annotatedTagSchema.safeParse(
      await readGitHubResource(request, `/git/tags/${object.sha}`),
    );
    if (!tagged.success || tagged.data.sha !== object.sha) return "source_mismatch";
    object = tagged.data.object;
  }
  if (object.type !== "commit" || object.sha !== target.sourceRevision) return "source_mismatch";

  const file = fileSchema.safeParse(workflowFile);
  if (!file.success || file.data.path !== target.workflowPath) return "workflow_contract_mismatch";
  try {
    const fileBytes = Uint8Array.from(atob(file.data.content.replace(/\s/g, "")), (value) =>
      value.charCodeAt(0),
    );
    if (fileBytes.length !== file.data.size) return "workflow_contract_mismatch";
    const yaml: unknown = parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fileBytes),
      {
        maxAliasCount: 0,
      },
    );
    const definition = dispatchWorkflowSchema.parse(yaml).on.workflow_dispatch.inputs;
    if (
      reservedInputs.some(
        (key) => definition[key]?.type !== "string" || definition[key]?.required !== true,
      ) ||
      Object.keys(target.inputs).some((key) => definition[key]?.type !== "string") ||
      Object.entries(definition).some(
        ([key, value]) =>
          value.required &&
          !reservedInputs.some((reserved) => reserved === key) &&
          !Object.hasOwn(target.inputs, key),
      )
    )
      return "workflow_contract_mismatch";
  } catch {
    return "workflow_contract_mismatch";
  }
  return null;
}

export async function dispatchActionsDelivery(
  options: ProviderOptions & { target: ActionsDeliveryOperation },
): Promise<ActionsDispatchResult> {
  const { target, signal } = options;
  const mint = options.mintToken ?? mintActionsDeliveryToken;
  const credential = await mint({
    installationId: target.installationId,
    repositoryNumericId: target.repositoryNumericId,
    mode: "dispatch",
    signal,
  });
  if (credential.kind === "blocked") return { kind: "rejected", reason: credential.reason };
  const request = repositoryRequest(target, credential.token, options);

  try {
    const reason = await checkDispatchTarget(target, request);
    if (reason) return { kind: "rejected", reason };
    signal.throwIfAborted();
  } catch (error) {
    return {
      kind: "rejected",
      reason:
        error instanceof GitHubRequestError &&
        isDefinitiveResponse(error.response) &&
        [401, 403].includes(error.response.status)
          ? "permission_missing"
          : "github_unavailable",
    };
  }

  try {
    const response = await request(`/actions/workflows/${target.workflowId}/dispatches`, {
      ref: `refs/tags/${target.tag}`,
      inputs: {
        ...target.inputs,
        wallie_command_id: target.commandId,
        wallie_source_sha: target.sourceRevision,
        wallie_environment: target.environment,
        wallie_run_nonce: target.runNonce,
      },
    });
    const result = dispatchResponse.safeParse(response);
    return result.success
      ? { kind: "accepted", runId: result.data.workflow_run_id }
      : { kind: "unknown" };
  } catch (error) {
    if (!(error instanceof GitHubRequestError) || !isDefinitiveResponse(error.response))
      return { kind: "unknown" };
    return {
      kind: "rejected",
      reason: [401, 403].includes(error.response.status)
        ? "permission_missing"
        : "provider_refused",
    };
  }
}

export async function observeActionsDelivery(
  options: ProviderOptions & { target: ActionsDeliveryObservation },
): Promise<ActionsObservationResult> {
  const { target, signal } = options;
  const mint = options.mintToken ?? mintActionsDeliveryToken;
  const credential = await mint({
    installationId: target.installationId,
    repositoryNumericId: target.repositoryNumericId,
    mode: "observe",
    signal,
  });
  if (credential.kind === "blocked") return { kind: "unverified", reason: credential.reason };

  const get = repositoryRequest(target, credential.token, options);
  const title = `wallie:${target.runNonce}`;
  const earliest = Math.floor(Date.parse(target.dispatchStartedAt) / 1000) * 1000;
  const latest = earliest + 70_000;
  const known = target.runId;
  const matches = (candidate: z.infer<typeof runSchema>) =>
    candidate.display_title === title &&
    candidate.workflow_id === target.workflowId &&
    candidate.repository.id === target.repositoryNumericId &&
    candidate.head_repository.id === target.repositoryNumericId &&
    candidate.head_sha === target.sourceRevision &&
    [target.tag, `refs/tags/${target.tag}`].includes(candidate.head_branch) &&
    [
      `${target.workflowPath}@${target.tag}`,
      `${target.workflowPath}@refs/tags/${target.tag}`,
    ].includes(candidate.path) &&
    candidate.actor.login.toLowerCase() === credential.actorLogin.toLowerCase() &&
    Date.parse(candidate.created_at) >= earliest &&
    Date.parse(candidate.created_at) <= latest;

  try {
    let raw: unknown;
    if (known !== null) {
      raw = await readGitHubResource(get, `/actions/runs/${known}`);
      if (raw === null) return { kind: "unverified", reason: "run_unavailable" };
    } else {
      const query = new URLSearchParams({
        event: "workflow_dispatch",
        head_sha: target.sourceRevision,
        created: `${new Date(earliest).toISOString()}..${new Date(latest).toISOString()}`,
        per_page: "25",
      });
      const response = z
        .object({
          total_count: z.number().int().nonnegative(),
          workflow_runs: z.array(z.object({ display_title: z.string() }).passthrough()).max(25),
        })
        .parse(await get(`/actions/workflows/${target.workflowId}/runs?${query}`));
      if (response.total_count !== response.workflow_runs.length)
        return { kind: "unverified", reason: "run_mismatch" };
      const candidates = response.workflow_runs.filter((run) => run.display_title === title);
      if (!candidates.length) return { kind: "unverified", reason: "run_unavailable" };
      if (candidates.length !== 1) return { kind: "unverified", reason: "run_mismatch" };
      raw = candidates[0];
    }
    const run = runSchema.safeParse(raw);
    if (!run.success || (known !== null && run.data.id !== known) || !matches(run.data))
      return { kind: "unverified", reason: "run_mismatch" };
    return {
      kind: "observed",
      runId: run.data.id,
      status: run.data.status,
      conclusion: run.data.conclusion,
    };
  } catch {
    return { kind: "unverified", reason: "github_unavailable" };
  }
}
