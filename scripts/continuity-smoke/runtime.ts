import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv, promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";

import type { Database, Tables } from "../../src/lib/supabase/database.types";
import {
  createUtilitySandbox,
  hasRecoverableSandboxSource,
  stopSandboxById,
} from "../../src/lib/sandbox";
import type { SandboxConnection, SandboxHandle } from "../../src/lib/sandbox/types";
import { initializeCheckpointRepository } from "../../src/lib/sandbox/setup";
import { checkoutSandboxCheckpoint } from "../../src/lib/sandbox/checkout";
import { captureSourceCheckpoint, readSourceBase } from "../../src/lib/pipeline/source-checkpoint";
import {
  restoreAndPushSourceWithWorkspace,
  type GitExecutor,
  type SourceGitWorkspace,
} from "../../src/lib/pipeline/source-delivery-git-core";
import { promoteCanonicalRefsWithWorkspace } from "../../src/lib/pipeline/canonical-pr-git";
import { createCanonicalPrApi } from "../../src/lib/pipeline/canonical-pr-api";

export const exec = promisify(execFile);
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
let runtimeStep = "not-started";
export const getRuntimeStep = () => runtimeStep;
export const APPROVED_SMOKE_REPOSITORY = {
  fullName: "anantjain-xyz/wallie-dev",
  numericId: 1196742316,
} as const;
export type Label = "plan" | "build" | "revision" | "verify";
export type CleanupReceipt = { sandboxId: string; stopped: true; sourceAvailable: false };
export const providerReceipts: Array<{
  sandboxId: string;
  stopped: boolean;
  sourceAvailable: boolean | null;
}> = [];
export type Evidence = {
  label: Label;
  workerPid: number;
  releaseRevision: number;
  jobId: string;
  runId: string;
  inputSha: string;
  inputRef: string | null;
  sourceCheckpointRunId: string | null;
  initialBaseSha: string;
  observedBeforeSha: string;
  outputSha: string;
  checkpointKind: "bundle" | "unchanged";
  bundleSha256: string | null;
  bundleBytes: number;
  fileDigestsBefore: Record<string, string | null>;
  fileDigestsAfter: Record<string, string | null>;
  cleanup: CleanupReceipt[];
  outputRef?: string;
  artifactId?: string;
  artifactVersion?: number;
  canonical?: {
    operationId: string;
    releaseRevision: number;
    epochId: string;
    headSha: string;
    fenceSha: string;
    prNumber: number;
    prUrl: string;
  };
  publicationWorkerPid?: number;
};
export type Manifest = {
  format: 1;
  repository: string;
  repositoryNumericId: number;
  fixtureRunId: string;
  baseBranch: string;
  repositoryId: string;
  workspaceId: string;
  memberId: string;
  databaseWorkdir: string;
  vercelEnvFile: string;
  initialBaseSha: string;
  pipelineId: string;
  sessionId: string;
  nextJobId: string;
  releaseRevision: number;
  evidence: Evidence[];
};
export type Gate = { enabled: boolean; revision: number; reason: string; updated_at: string };

/** Failure artifacts contain an allowlist of validated identities and digests only. */
export function sanitizedManifestEvidence(manifest: Manifest) {
  const id = (value: unknown) =>
    typeof value === "string" && UUID.test(value) ? value : undefined;
  const sha = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : undefined;
  const digest = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const ref = (value: unknown) =>
    value === null
      ? null
      : typeof value === "string" &&
          /^refs\/heads\/wallie\/[A-Za-z0-9_./-]{1,1000}$/.test(value) &&
          !value.includes("..")
        ? value
        : undefined;
  const fileDigests = (value: unknown) =>
    Object.fromEntries(
      ["README.md", "vercel.json", "plan.txt", "build.txt", "default-drift.txt"].map((name) => [
        name,
        digest(
          value && typeof value === "object" ? (value as Record<string, unknown>)[name] : null,
        ),
      ]),
    );
  return {
    repository: APPROVED_SMOKE_REPOSITORY.fullName,
    fixtureRunId: id(manifest.fixtureRunId),
    workspaceId: id(manifest.workspaceId),
    memberId: id(manifest.memberId),
    repositoryId: id(manifest.repositoryId),
    sessionId: id(manifest.sessionId),
    pipelineId: id(manifest.pipelineId),
    nextJobId: id(manifest.nextJobId),
    releaseRevision: number(manifest.releaseRevision),
    initialBaseSha: sha(manifest.initialBaseSha),
    baseRef: ref(`refs/heads/${manifest.baseBranch}`),
    evidence: (Array.isArray(manifest.evidence) ? manifest.evidence : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        label: ["plan", "build", "revision", "verify"].includes(item.label)
          ? item.label
          : undefined,
        workerPid: number(item.workerPid),
        publicationWorkerPid: number(item.publicationWorkerPid),
        releaseRevision: number(item.releaseRevision),
        jobId: id(item.jobId),
        runId: id(item.runId),
        artifactId: id(item.artifactId),
        artifactVersion: number(item.artifactVersion),
        inputSha: sha(item.inputSha),
        inputRef: ref(item.inputRef),
        sourceCheckpointRunId: id(item.sourceCheckpointRunId),
        initialBaseSha: sha(item.initialBaseSha),
        observedBeforeSha: sha(item.observedBeforeSha),
        outputSha: sha(item.outputSha),
        outputRef: ref(item.outputRef),
        checkpointKind: ["bundle", "unchanged"].includes(item.checkpointKind)
          ? item.checkpointKind
          : undefined,
        bundleSha256: digest(item.bundleSha256),
        bundleBytes: number(item.bundleBytes),
        fileDigestsBefore: fileDigests(item.fileDigestsBefore),
        fileDigestsAfter: fileDigests(item.fileDigestsAfter),
        cleanup: (Array.isArray(item.cleanup) ? item.cleanup : [])
          .filter(
            (receipt) =>
              receipt &&
              typeof receipt.sandboxId === "string" &&
              /^[A-Za-z0-9_-]{1,200}$/.test(receipt.sandboxId) &&
              receipt.stopped === true &&
              receipt.sourceAvailable === false,
          )
          .map((receipt) => ({
            sandboxId: receipt.sandboxId,
            stopped: true,
            sourceAvailable: false,
          })),
        ...(item.canonical
          ? {
              canonical: {
                operationId: id(item.canonical.operationId),
                epochId: id(item.canonical.epochId),
                releaseRevision: number(item.canonical.releaseRevision),
                headSha: sha(item.canonical.headSha),
                fenceSha: sha(item.canonical.fenceSha),
                prNumber: number(item.canonical.prNumber),
                prUrl: /^https:\/\/github\.com\/anantjain-xyz\/wallie-dev\/pull\/[1-9][0-9]*$/.test(
                  item.canonical.prUrl,
                )
                  ? item.canonical.prUrl
                  : undefined,
              },
            }
          : {}),
      })),
  };
}

export async function required<Result extends { data: unknown; error: unknown }>(
  query: PromiseLike<Result>,
): Promise<NonNullable<Result["data"]>> {
  const result = await query;
  if (result.error || result.data == null) throw new Error("Smoke database operation failed.");
  return result.data as NonNullable<Result["data"]>;
}

export async function loadContext(
  options: Pick<Manifest, "databaseWorkdir" | "vercelEnvFile" | "repository">,
) {
  const status = JSON.parse(
    (
      await exec("supabase", ["status", "-o", "json"], {
        cwd: options.databaseWorkdir,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      })
    ).stdout,
  ) as Record<string, string>;
  const api = new URL(status.API_URL);
  const database = new URL(status.DB_URL);
  if (
    api.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(api.hostname) ||
    api.port !== "50321" ||
    !["postgres", "postgresql"].includes(database.protocol.slice(0, -1)) ||
    !["127.0.0.1", "localhost"].includes(database.hostname) ||
    database.port !== "50322" ||
    !status.SERVICE_ROLE_KEY
  )
    throw new Error("Only the dedicated loopback smoke database is permitted.");
  const env = parseEnv(await readFile(options.vercelEnvFile, "utf8"));
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = env;
  if (!token || !teamId || !projectId)
    throw new Error("Vercel operator configuration is unavailable.");
  const connection: SandboxConnection = {
    provider: "vercel",
    revision: "49900000-0000-4000-8000-000000000001",
    credentials: { token, teamId, projectId },
  };
  const githubToken = (
    await exec("gh", ["auth", "token", "--hostname", "github.com"], {
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    })
  ).stdout.trim();
  if (!githubToken) throw new Error("GitHub operator authentication is unavailable.");
  const admin = createClient<Database>(api.origin, status.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const control = admin;
  const signal = AbortSignal.timeout(600_000);
  const github = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${options.repository}${path}`, {
      method,
      signal,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("Smoke GitHub operation failed.");
    return (await response.json()) as T;
  };
  return {
    admin,
    control,
    connection,
    githubToken,
    signal,
    github,
    repository: options.repository,
  };
}
export type Context = Awaited<ReturnType<typeof loadContext>>;

export async function readManifest(path: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
  assert.equal(manifest.format, 1);
  assert.match(manifest.fixtureRunId, UUID);
  assert.equal(manifest.baseBranch, `wallie/continuity-fixture/${manifest.fixtureRunId}/base`);
  assert.equal(manifest.repository, APPROVED_SMOKE_REPOSITORY.fullName);
  assert.equal(manifest.repositoryNumericId, APPROVED_SMOKE_REPOSITORY.numericId);
  for (const id of [
    manifest.workspaceId,
    manifest.memberId,
    manifest.repositoryId,
    manifest.sessionId,
    manifest.pipelineId,
    manifest.nextJobId,
  ])
    assert.match(id, UUID);
  assert.match(manifest.repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
  return manifest;
}
export async function saveManifest(path: string, manifest: Manifest) {
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
}

export async function withUtility<T>(
  context: Context,
  manifest: Manifest,
  runId: string,
  receipts: CleanupReceipt[],
  callback: (sandbox: SandboxHandle) => Promise<T>,
): Promise<T> {
  let sandboxId: string | undefined;
  try {
    const handle = await createUtilitySandbox(
      {
        workspaceId: manifest.workspaceId,
        ownerId: runId,
        timeoutMs: 180_000,
        signal: context.signal,
        onSandboxCreated: async (metadata) => {
          sandboxId = metadata.sandboxId;
        },
      },
      context.connection,
    );
    sandboxId = handle.id;
    return await callback(handle);
  } finally {
    if (sandboxId) {
      try {
        await stopSandboxById(sandboxId, { connection: context.connection, throwOnError: true });
        assert.equal(await hasRecoverableSandboxSource(sandboxId, context.connection), false);
        receipts.push({ sandboxId, stopped: true, sourceAvailable: false });
        providerReceipts.push({ sandboxId, stopped: true, sourceAvailable: false });
      } catch {
        runtimeStep = "sandbox-cleanup";
        providerReceipts.push({ sandboxId, stopped: false, sourceAvailable: null });
        throw new Error("Smoke sandbox cleanup could not be confirmed.");
      }
    }
  }
}

export async function withGitUtility<T>(
  context: Context,
  manifest: Manifest,
  runId: string,
  receipts: CleanupReceipt[],
  callback: (dependencies: {
    execGit: GitExecutor;
    createWorkspace: () => Promise<SourceGitWorkspace>;
  }) => Promise<T>,
  allowedPushRefs: string[],
) {
  return withUtility(context, manifest, runId, receipts, async (sandbox) => {
    const path = `/tmp/wallie-continuity-${randomUUID()}`;
    const mkdir = await sandbox.exec("mkdir", ["-m", "700", path], {
      cwd: "/tmp",
      signal: context.signal,
    });
    assert.equal(await mkdir.exitCode, 0);
    return callback({
      execGit: async (args, options) => {
        if (args[0] === "push") assertOwnedPush(args, allowedPushRefs);
        const command = await sandbox.exec("git", args, {
          cwd: options.cwd,
          env: Object.fromEntries(
            Object.entries(options.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout)]),
        });
        const [output, code] = await Promise.all([command.output(), command.exitCode]);
        if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > options.maxBuffer)
          throw new Error("Smoke Git output exceeded its bound.");
        if (code !== 0) throw Object.assign(new Error("Smoke Git command failed."), { code });
        return output;
      },
      createWorkspace: async () => ({
        path,
        writeBundle: (bytes) => sandbox.writeFile(`${path}/source.bundle`, bytes, { mode: 0o600 }),
        close: async () => {},
      }),
    });
  });
}

export function assertOwnedPush(args: string[], allowedRefs: string[]) {
  const refspecs = args.filter((arg) => !arg.startsWith("--") && arg.includes(":refs/"));
  assert.ok(refspecs.length > 0);
  for (const spec of refspecs) {
    assert.match(spec, /^[a-f0-9]{40}:refs\/heads\//);
    assert.ok(allowedRefs.includes(spec.slice(spec.indexOf(":") + 1)));
  }
  assert.ok(!args.includes("--delete") && !args.includes("--mirror") && !args.includes("--all"));
}
const FILES = ["README.md", "vercel.json", "plan.txt", "build.txt", "default-drift.txt"];
async function digests(sandbox: SandboxHandle) {
  const result: Record<string, string | null> = {};
  for (const name of FILES) {
    const contents = await sandbox.readFile(`${sandbox.repoPath}/${name}`);
    result[name] = contents === null ? null : createHash("sha256").update(contents).digest("hex");
  }
  return result;
}

export async function produce(
  context: Context,
  manifest: Manifest,
  label: Label,
): Promise<Evidence> {
  const { admin, signal } = context;
  runtimeStep = "load-session";
  const session = await required(
    admin
      .from("sessions")
      .select("*")
      .eq("id", manifest.sessionId)
      .eq("workspace_id", manifest.workspaceId)
      .single(),
  );
  runtimeStep = "claim-job";
  const jobs = await required(admin.rpc("claim_next_agent_job", { default_concurrency_limit: 3 }));
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.id, manifest.nextJobId);
  assert.equal(job.session_id, manifest.sessionId);
  runtimeStep = "verify-job-admission";
  const admission = await required(
    context.control
      .from("agent_jobs")
      .select("git_continuity_release_revision")
      .eq("id", job.id)
      .single(),
  );
  assert.equal(admission.git_continuity_release_revision, manifest.releaseRevision);
  runtimeStep = "start-attempt";
  const runId = await required(
    admin.rpc("start_session_job_attempt", {
      p_job_id: job.id,
      p_attempt_count: job.attempt_count,
      p_expected_stage_id: session.current_stage_id,
      p_expected_artifact_version: session.current_artifact_version ?? 0,
      p_model_provider: "codex",
      p_model_name: "deterministic-release-smoke",
      p_run_type: "project",
      p_branch_name: `wallie/continuity-smoke/${job.id}`,
    }),
  );
  assert.match(runId, UUID);
  runtimeStep = "load-pinned-input";
  const selected = await admin
    .from("session_job_git_inputs")
    .select("*")
    .eq("job_id", job.id)
    .maybeSingle();
  if (selected.error) throw new Error("Smoke pinned-input read failed.");
  const selection = selected.data;
  const expectedInput = selection?.input_sha ?? manifest.initialBaseSha;
  const receipts: CleanupReceipt[] = [];
  runtimeStep = "create-source-sandbox";
  const produced = await withUtility(context, manifest, runId, receipts, async (sandbox) => {
    runtimeStep = "record-source-sandbox-metadata";
    assert.equal(context.connection.provider, "vercel");
    const { teamId, projectId } = context.connection.credentials;
    assert.ok(teamId && projectId);
    await required(
      admin
        .from("agent_runs")
        .update({
          sandbox_id: sandbox.id,
          sandbox_provider: "vercel",
          sandbox_connection_revision: context.connection.revision,
          sandbox_vercel_team_id: teamId,
          sandbox_vercel_project_id: projectId,
        })
        .eq("id", runId)
        .eq("attempt_count", job.attempt_count)
        .eq("workspace_id", manifest.workspaceId)
        .eq("status", "running")
        .select("id")
        .single(),
    );
    const branch = `wallie/continuity-smoke/${job.id}`;
    runtimeStep = "initialize-source-repository";
    await initializeCheckpointRepository({
      handle: sandbox,
      repoAlreadyCloned: false,
      request: {
        sessionId: manifest.sessionId,
        workspaceId: manifest.workspaceId,
        ownerId: runId,
        repoFullName: manifest.repository,
        branch,
        baseBranch: manifest.baseBranch,
        installationToken: context.githubToken,
        agentProvider: "codex",
        mode: {
          kind: "checkpoint",
          sha: expectedInput,
          ...(selection?.input_ref ? { ref: selection.input_ref } : {}),
        },
        signal,
      },
    });
    runtimeStep = "restore-pinned-checkpoint";
    await checkoutSandboxCheckpoint({
      sandbox,
      branch,
      checkpoint: {
        sha: expectedInput,
        ...(selection?.input_ref ? { ref: selection.input_ref } : {}),
      },
      signal,
    });
    runtimeStep = "pin-job-input";
    const observedBeforeSha = await readSourceBase(sandbox, signal);
    const pinned = (
      await required(
        admin.rpc("pin_session_job_git_input", {
          p_job_id: job.id,
          p_attempt_count: job.attempt_count,
          p_run_id: runId,
          p_repository_id: manifest.repositoryId,
          p_base_branch: manifest.baseBranch,
          p_observed_sha: observedBeforeSha,
        }),
      )
    )[0];
    assert.equal(pinned.input_sha, observedBeforeSha);
    assert.equal(pinned.base_branch, manifest.baseBranch);
    runtimeStep = "verify-input-byte-digests";
    const before = await digests(sandbox);
    const previous = manifest.evidence.at(-1);
    if (previous) {
      assert.equal(pinned.input_sha, previous.outputSha);
      assert.deepEqual(before, previous.fileDigestsAfter);
    }
    runtimeStep = "apply-deterministic-source-change";
    if (label === "plan")
      await sandbox.writeFile(`${sandbox.repoPath}/plan.txt`, "Reviewed plan source\n");
    if (label === "build")
      await sandbox.writeFile(`${sandbox.repoPath}/build.txt`, "Build version one\n");
    if (label === "revision")
      await sandbox.writeFile(
        `${sandbox.repoPath}/build.txt`,
        "Build version two after request changes\n",
      );
    runtimeStep = "capture-source-checkpoint";
    const checkpoint = await captureSourceCheckpoint({
      sandbox,
      baseSha: pinned.input_sha,
      signal,
      sensitiveValues: [context.githubToken, context.connection.credentials.token],
    });
    const after = await digests(sandbox);
    assert.equal(checkpoint.kind, label === "verify" ? "unchanged" : "bundle");
    runtimeStep = "prepare-durable-publication";
    const prepared = await required(
      admin.rpc("prepare_session_source_and_checkpoint_publication", {
        p_run_id: runId,
        p_repository_id: manifest.repositoryId,
        p_base_branch: manifest.baseBranch,
        p_base_sha: checkpoint.baseSha,
        p_head_sha: checkpoint.headSha,
        p_title: `Continuity smoke ${label}`,
        p_body: "Controlled release acceptance fixture.",
        p_checkpoint_path: "",
        p_bundle_sha256: checkpoint.kind === "bundle" ? checkpoint.sha256 : "",
        p_bundle_base64: checkpoint.kind === "bundle" ? checkpoint.bytes.toString("base64") : "",
        p_expected_artifact_version: session.current_artifact_version ?? 0,
        p_artifact_md: `# ${label}\n\nDeterministic source fixture completed.`,
      }),
    );
    assert.equal(prepared, true);
    runtimeStep = "source-prepared";
    return {
      label,
      workerPid: process.pid,
      releaseRevision: manifest.releaseRevision,
      jobId: job.id,
      runId,
      inputSha: pinned.input_sha,
      inputRef: pinned.input_ref,
      sourceCheckpointRunId: pinned.source_checkpoint_run_id,
      initialBaseSha: pinned.initial_base_sha,
      observedBeforeSha,
      outputSha: checkpoint.headSha,
      checkpointKind: checkpoint.kind,
      bundleSha256: checkpoint.kind === "bundle" ? checkpoint.sha256 : null,
      bundleBytes: checkpoint.kind === "bundle" ? checkpoint.bytes.length : 0,
      fileDigestsBefore: before,
      fileDigestsAfter: after,
      cleanup: receipts,
    } satisfies Evidence;
  });
  return produced;
}

export async function publishPrepared(context: Context, manifest: Manifest, evidence: Evidence) {
  const { admin, signal } = context;
  // Everything below reloads durable database state. No producer sandbox or bundle
  // bytes survive the process boundary used for the revised-build recovery case.
  const claim = await required(
    admin.rpc("claim_session_checkpoint_publication", { p_run_id: evidence.runId }),
  );
  const publication = await required(
    admin
      .from("session_checkpoint_publications")
      .select("*")
      .eq("run_id", evidence.runId)
      .eq("claim_id", claim)
      .single(),
  );
  const source = await required(
    admin
      .from("session_source_deliveries")
      .select("*")
      .eq("run_id", evidence.runId)
      .eq("workspace_id", manifest.workspaceId)
      .single(),
  );
  const assertClaim = async () => {
    assert.equal(
      await required(
        admin.rpc("assert_session_checkpoint_publication_claim", {
          p_run_id: evidence.runId,
          p_claim_id: claim,
        }),
      ),
      true,
    );
  };
  await assertClaim();
  if (source.base_sha !== source.head_sha) {
    assert.ok(publication.retained_ref?.startsWith("refs/heads/"));
    assert.equal(
      publication.retained_ref,
      `refs/heads/wallie/checkpoints/${evidence.runId}/${source.head_sha}`,
    );
    assert.ok(source.bundle_base64);
    const bytes = Buffer.from(source.bundle_base64, "base64");
    const branch = await withGitUtility(
      context,
      manifest,
      evidence.runId,
      evidence.cleanup,
      (dependencies) =>
        restoreAndPushSourceWithWorkspace(
          {
            baseSha: source.base_sha,
            headSha: source.head_sha,
            branch: publication.retained_ref!.slice("refs/heads/".length),
            exactRef: true,
            bytes,
            sha256: source.bundle_sha256!,
            remoteUrl: `https://github.com/${manifest.repository}.git`,
            token: context.githubToken,
            signal,
            beforePush: assertClaim,
          },
          dependencies,
        ),
      [publication.retained_ref!],
    );
    assert.equal(`refs/heads/${branch}`, publication.retained_ref);
  }
  await assertClaim();
  assert.equal(
    await required(
      admin.rpc("adopt_session_checkpoint_publication", {
        p_run_id: evidence.runId,
        p_claim_id: claim,
        ...(publication.retained_ref
          ? { p_remote_ref: publication.retained_ref, p_remote_sha: source.head_sha }
          : {}),
      }),
    ),
    true,
  );
  const checkpoint = await required(
    admin.from("session_git_checkpoints").select("*").eq("run_id", evidence.runId).single(),
  );
  assert.equal(checkpoint.output_sha, evidence.outputSha);
  evidence.outputRef = checkpoint.output_ref ?? undefined;
  evidence.artifactId = checkpoint.artifact_id;
  const artifact = await required(
    admin.from("session_artifacts").select("version").eq("id", checkpoint.artifact_id).single(),
  );
  evidence.artifactVersion = artifact.version;
  evidence.publicationWorkerPid = process.pid;
  const cursor = await required(
    admin
      .from("session_git_heads")
      .select("checkpoint_run_id")
      .eq("session_id", manifest.sessionId)
      .single(),
  );
  assert.equal(cursor.checkpoint_run_id, evidence.runId);
}

export async function synchronizeCanonical(
  context: Context,
  manifest: Manifest,
  evidence: Evidence,
) {
  const { admin, signal } = context;
  const claim = await required(
    admin.rpc("claim_session_pr_sync", { p_session_id: manifest.sessionId }),
  );
  const operation = await required(
    admin.from("session_pr_operations").select("*").eq("claim_id", claim).single(),
  );
  const epoch = await required(
    admin.from("session_pr_epochs").select("*").eq("id", operation.epoch_id).single(),
  );
  assert.equal(operation.session_id, manifest.sessionId);
  assert.equal(epoch.session_id, manifest.sessionId);
  assert.equal(epoch.branch_name, `wallie/sessions/${manifest.sessionId}/${epoch.id}`);
  assert.equal(epoch.fence_branch, `wallie/session-fences/${epoch.id}`);
  const admission = await required(
    context.control
      .from("session_pr_operations")
      .select("git_continuity_release_revision")
      .eq("id", operation.id)
      .single(),
  );
  assert.equal(admission.git_continuity_release_revision, manifest.releaseRevision);
  assert.equal(operation.desired_sha, evidence.outputSha);
  assert.equal(epoch.repository_full_name, manifest.repository);
  const api = createCanonicalPrApi({
    repositoryFullName: manifest.repository,
    repositoryNumericId: manifest.repositoryNumericId,
    branchName: epoch.branch_name,
    baseBranch: epoch.base_branch,
    token: context.githubToken,
    signal,
  });
  let pr = epoch.pr_number ? await api.get(epoch.pr_number) : await api.find();
  if (pr) assert.equal(pr.state, "open");
  const assertClaim = async () => {
    assert.equal(
      await required(
        admin.rpc("assert_session_pr_sync_claim", {
          p_operation_id: operation.id,
          p_claim_id: claim,
        }),
      ),
      true,
    );
  };
  const pair = await withGitUtility(
    context,
    manifest,
    evidence.runId,
    evidence.cleanup,
    (dependencies) =>
      promoteCanonicalRefsWithWorkspace(
        {
          operationId: operation.id,
          desiredSha: operation.desired_sha,
          sourceRef: operation.source_ref,
          branchName: epoch.branch_name,
          fenceBranch: epoch.fence_branch,
          expectedHeadSha: operation.expected_head_sha,
          expectedFenceSha: operation.expected_fence_sha,
          desiredFenceSha: operation.desired_fence_sha,
          remoteUrl: `https://github.com/${manifest.repository}.git`,
          token: context.githubToken,
          signal,
          beforePush: async () => {
            await assertClaim();
            if (pr) assert.equal((await api.get(pr.number)).state, "open");
          },
        },
        dependencies,
      ),
    [`refs/heads/${epoch.branch_name}`, `refs/heads/${epoch.fence_branch}`],
  );
  await assertClaim();
  pr ??= await api.find();
  if (!pr) {
    assert.equal(
      await required(
        admin.rpc("arm_session_pr_creation", {
          p_epoch_id: epoch.id,
          p_operation_id: operation.id,
          p_claim_id: claim,
        }),
      ),
      true,
    );
    // A failed POST is never repeated. Production find() observes all states.
    try {
      pr = await api.create({
        draft: true,
        title: `[SMOKE ONLY — DO NOT MERGE] OP-499 continuity ${manifest.fixtureRunId}`,
        body: `SMOKE ONLY — DO NOT MERGE.\n\nIsolated deterministic OP-499 fixture in the user-approved wallie-dev repository. This PR targets only this run's fixture base branch (${manifest.baseBranch}), never main.\n\nRun: ${manifest.fixtureRunId}\nSession: ${manifest.sessionId}\n\nNo production promotion or manual deployment is performed. Fixture source contains vercel.json disabling Git deployments; empty-tree protocol fence commits may still trigger a provider check attempt.`,
      });
    } catch {
      pr = await api.find();
      if (!pr) throw new Error("Smoke PR creation outcome uncertain.");
    }
  }
  const observation = await required(
    admin.rpc("begin_session_pr_sync_observation", {
      p_operation_id: operation.id,
      p_claim_id: claim,
      p_pr_number: pr.number,
      p_pr_url: pr.url,
    }),
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    pr = await api.get(pr.number);
    if (pr.headSha === pair.headSha) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(pr.headSha, pair.headSha);
  assert.equal(pr.state, "open");
  await assertClaim();
  assert.equal(
    await required(
      admin.rpc("finish_session_pr_sync", {
        p_operation_id: operation.id,
        p_claim_id: claim,
        p_observation_id: observation,
        p_observed_head_sha: pair.headSha,
        p_observed_fence_sha: pair.fenceSha,
        p_pr_number: pr.number,
        p_pr_url: pr.url,
        p_pr_state: pr.state,
        p_is_draft: pr.draft,
        p_pr_head_sha: pr.headSha,
        p_pr_updated_at: pr.updatedAt,
      }),
    ),
    true,
  );
  const previous = manifest.evidence.find((item) => item.canonical)?.canonical;
  if (previous) {
    assert.equal(pr.number, previous.prNumber);
    assert.equal(epoch.id, previous.epochId);
  }
  evidence.canonical = {
    operationId: operation.id,
    releaseRevision: manifest.releaseRevision,
    epochId: epoch.id,
    ...pair,
    prNumber: pr.number,
    prUrl: pr.url,
  };
}

export async function decide(context: Context, manifest: Manifest, action: "approve" | "reject") {
  const last = manifest.evidence.at(-1)!;
  assert.ok(last.artifactId);
  const session = await required(
    context.admin.from("sessions").select("current_stage_id").eq("id", manifest.sessionId).single(),
  );
  const result =
    action === "approve"
      ? await required(
          context.admin.rpc("approve_session_stage", {
            target_session_id: manifest.sessionId,
            expected_workspace_id: manifest.workspaceId,
            expected_stage_id: session.current_stage_id,
            expected_artifact_id: last.artifactId,
            expected_version: last.artifactVersion!,
            approver_member_id: manifest.memberId,
            p_agent_model_provider: "codex",
            p_agent_model_name: "deterministic-release-smoke",
            p_run_type: "project",
          }),
        )
      : await required(
          context.admin.rpc("reject_session_stage", {
            p_session_id: manifest.sessionId,
            p_workspace_id: manifest.workspaceId,
            p_expected_stage_id: session.current_stage_id,
            p_expected_artifact_id: last.artifactId,
            p_artifact_version: last.artifactVersion!,
            p_feedback_text: "Keep the reviewed plan and revise build bytes to version two.",
            p_requested_by_member_id: manifest.memberId,
            p_agent_model_provider: "codex",
            p_agent_model_name: "deterministic-release-smoke",
            p_run_type: "project",
          }),
        );
  assert.equal(result.length, 1);
  manifest.nextJobId = result[0].job_id;
  return result[0];
}

export type RepositoryRow = Tables<"github_repositories">;
