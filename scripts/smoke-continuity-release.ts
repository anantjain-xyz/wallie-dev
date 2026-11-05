/**
 * Guarded OP-499 release acceptance: actual local lifecycle RPCs, real Vercel
 * checkout/capture/Git utilities, and GitHub PR API. The agent is deterministic;
 * this script does not run an LLM or claim to execute the production daemon.
 * Preview is the default. Root/operator must review before adding --execute.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decide,
  assertOwnedPush,
  exec,
  loadContext,
  getRuntimeStep,
  produce,
  providerReceipts,
  publishPrepared,
  readManifest,
  required,
  APPROVED_SMOKE_REPOSITORY,
  saveManifest,
  sanitizedManifestEvidence,
  synchronizeCanonical,
  UUID,
  type Context,
  type Gate,
  type Label,
  type Manifest,
} from "./continuity-smoke/runtime";

let phase = "arguments";
let repositoryForFailure: string | undefined;
let partialEvidence: ReturnType<typeof sanitizedManifestEvidence> | undefined;
let retainedEvidenceFile: string | undefined;
let childFailure:
  | { phase: string; step?: string; providerReceipts: typeof providerReceipts }
  | undefined;
let concurrentChanges:
  | { refs: string[]; pullRequests: number[]; defaultBranch: boolean }
  | undefined;
const script = fileURLToPath(import.meta.url);
function args() {
  const result: Record<string, string | boolean> = {};
  const input = process.argv.slice(2);
  for (let index = 0; index < input.length; index++) {
    const key = input[index];
    if (["--execute", "--help"].includes(key)) {
      if (result[key]) throw new Error("Duplicate flag.");
      result[key] = true;
    } else if (
      [
        "--repository",
        "--workspace-id",
        "--member-id",
        "--repository-id",
        "--database-workdir",
        "--vercel-env-file",
        "--worker",
        "--manifest",
        "--label",
      ].includes(key)
    ) {
      if (result[key] || !input[index + 1] || input[index + 1].startsWith("--"))
        throw new Error("Invalid flag value.");
      result[key] = input[++index];
    } else throw new Error("Unknown flag.");
  }
  return result;
}
function gateRow(value: unknown): Gate {
  const row = Array.isArray(value) ? value[0] : undefined;
  assert.ok(
    row &&
      typeof row.enabled === "boolean" &&
      Number.isSafeInteger(row.revision) &&
      row.revision > 0 &&
      typeof row.reason === "string",
  );
  return row as Gate;
}
async function getGate(context: Context) {
  return gateRow(await required(context.control.rpc("get_git_continuity_release_state")));
}
async function setGate(context: Context, enabled: boolean, revision: number, reason: string) {
  return gateRow(
    await required(
      context.control.rpc("set_git_continuity_release", {
        p_enabled: enabled,
        p_expected_revision: revision,
        p_reason: reason,
      }),
    ),
  );
}

async function worker(options: Record<string, string | boolean>) {
  assert.equal(options["--execute"], true);
  assert.equal(process.env.WALLIE_CONTINUITY_SMOKE_CHILD, "1");
  assert.ok(typeof options["--manifest"] === "string");
  const path = options["--manifest"];
  const manifest = await readManifest(path);
  repositoryForFailure = manifest.repository;
  phase = `worker-${String(options["--worker"])}-${String(options["--label"])}`;
  const context = await loadContext(manifest);
  const metadata = await context.github<{
    id: number;
    private: boolean;
    archived: boolean;
    disabled: boolean;
    permissions?: { push?: boolean };
  }>("");
  assert.equal(metadata.id, manifest.repositoryNumericId);
  assert.equal(metadata.archived, false);
  assert.equal(metadata.disabled, false);
  assert.equal(metadata.permissions?.push, true);
  const owner = await required(
    context.admin
      .from("sessions")
      .select("workspace_id,github_repository_id,pipeline_id")
      .eq("id", manifest.sessionId)
      .single(),
  );
  assert.equal(owner.workspace_id, manifest.workspaceId);
  assert.equal(owner.github_repository_id, manifest.repositoryId);
  assert.equal(owner.pipeline_id, manifest.pipelineId);
  const binding = await required(
    context.admin
      .from("github_repositories")
      .select("full_name,repo_id,workspace_id")
      .eq("id", manifest.repositoryId)
      .single(),
  );
  assert.equal(binding.workspace_id, manifest.workspaceId);
  assert.equal(binding.repo_id, manifest.repositoryNumericId);
  assert.equal(binding.full_name.toLowerCase(), manifest.repository.toLowerCase());
  const gate = await getGate(context);
  assert.equal(gate.enabled, true);
  assert.equal(gate.revision, manifest.releaseRevision);
  if (options["--worker"] === "produce") {
    assert.ok(["plan", "build", "revision", "verify"].includes(String(options["--label"])));
    const label = options["--label"] as Label;
    const evidence = await produce(context, manifest, label);
    manifest.evidence.push(evidence);
    // Persist only IDs, hashes and cleanup receipts. Bundle bytes and every
    // credential stay in private DB/memory, never this child-process manifest.
    await saveManifest(path, manifest);
    if (label !== "revision") {
      await publishPrepared(context, manifest, evidence);
      await synchronizeCanonical(context, manifest, evidence);
      await saveManifest(path, manifest);
    }
  } else {
    assert.equal(options["--worker"], "recover-publication");
    const evidence = manifest.evidence.at(-1)!;
    assert.equal(evidence.label, "revision");
    assert.notEqual(evidence.workerPid, process.pid);
    assert.equal(evidence.artifactId, undefined);
    await publishPrepared(context, manifest, evidence);
    await synchronizeCanonical(context, manifest, evidence);
    await saveManifest(path, manifest);
  }
  console.log(JSON.stringify({ status: "worker-passed", phase, pid: process.pid, manifest: path }));
}

async function main() {
  const options = args();
  if (options["--help"]) {
    console.log(
      "Usage: node --import ./scripts/register-server-only.mjs --import tsx scripts/smoke-continuity-release.ts --workspace-id UUID --member-id UUID --repository-id UUID [--repository anantjain-xyz/wallie-dev] [--database-workdir /tmp/wallie499-db] [--vercel-env-file /path/to/operator.env] [--execute]",
    );
    return;
  }
  if (options["--worker"]) return worker(options);
  const repository = options["--repository"] ?? APPROVED_SMOKE_REPOSITORY.fullName;
  assert.ok(typeof repository === "string");
  assert.equal(repository, APPROVED_SMOKE_REPOSITORY.fullName);
  repositoryForFailure = repository;
  const identity = {
    workspaceId: String(options["--workspace-id"] ?? ""),
    memberId: String(options["--member-id"] ?? ""),
    repositoryId: String(options["--repository-id"] ?? ""),
  };
  for (const id of Object.values(identity)) assert.match(id, UUID);
  const databaseWorkdir = String(options["--database-workdir"] ?? "/tmp/wallie499-db");
  const vercelEnvFile = String(
    options["--vercel-env-file"] ?? "/Users/anant/src/wallie-dev/.env.local",
  );
  if (!options["--execute"]) {
    console.log(
      JSON.stringify({
        status: "preview",
        repository,
        mode: "explicitly-approved-existing-wallie-dev",
        newNamespace: "refs/heads/wallie/continuity-fixture/<new-run-UUID>/{base,default-drift}",
        ...identity,
        databaseWorkdir,
        requirements: [
          `Exact user-approved repository ${APPROVED_SMOKE_REPOSITORY.fullName} (numeric ID ${APPROVED_SMOKE_REPOSITORY.numericId}); public visibility permitted for this repository only`,
          "Dedicated loopback Supabase API50321/DB50322 with root-prepared fixture binding",
          "No other workers or release-eligible active jobs in the dedicated database",
          "Reviewed script and explicit --execute",
        ],
        writes: [
          "Create only run-specific base/default-drift branches with create-only leases; preserve main and all preexisting refs and PRs",
          "Exercise default-branch drift only on the new run base and the local fixture DB binding; never change the GitHub repository default",
          "Temporarily enable the local release gate using revision CAS; restore prior state in finally",
          "Create an isolated plan/build/verify pipeline and freshly enrolled session",
          "Real Vercel checkout/capture, immutable retained publication, adoption and canonical PR synchronization through actual local RPCs",
          "Approve plan, request build changes, restart a child worker from persisted Git input",
          "Restart again from a durable pending revised-build publication after destroying its producer sandbox",
          "Approve revised build into a text-only next stage; assert original canonical PR and byte/SHA lineage",
        ],
        cleanup:
          "Stop and verify every Vercel sandbox; remove local temporary files; preserve GitHub fixture and local DB evidence",
        secrets: "Loaded internally; never argv, manifests or output",
        agent: "Controlled deterministic file changes; no LLM or production-daemon claim",
        deployment:
          "Fixture vercel.json disables Git deployments. Empty-tree fence commits may still trigger provider checks; no project settings or protocol changes and no manual deployment.",
      }),
    );
    return;
  }
  phase = "local-and-approved-repository-validation";
  const context = await loadContext({ repository, databaseWorkdir, vercelEnvFile });
  const { admin } = context;
  const metadata = await context.github<{
    id: number;
    full_name: string;
    private: boolean;
    fork: boolean;
    archived: boolean;
    disabled: boolean;
    default_branch: string;
    permissions?: { push?: boolean };
  }>("");
  assert.equal(metadata.id, APPROVED_SMOKE_REPOSITORY.numericId);
  assert.equal(metadata.fork, false);
  assert.equal(metadata.archived, false);
  assert.equal(metadata.disabled, false);
  assert.equal(metadata.permissions?.push, true);
  assert.equal(metadata.full_name.toLowerCase(), repository.toLowerCase());
  const binding = await required(
    admin
      .from("github_repositories")
      .select("*")
      .eq("id", identity.repositoryId)
      .eq("workspace_id", identity.workspaceId)
      .single(),
  );
  assert.equal(binding.full_name.toLowerCase(), repository.toLowerCase());
  assert.equal(binding.repo_id, metadata.id);
  assert.equal(binding.private, metadata.private);
  const member = await required(
    admin
      .from("workspace_members")
      .select("role,kind,is_active")
      .eq("id", identity.memberId)
      .eq("workspace_id", identity.workspaceId)
      .single(),
  );
  assert.equal(member.kind, "human");
  assert.equal(member.is_active, true);
  assert.ok(["owner", "admin"].includes(member.role));
  const [enrollments, nonPipeline] = await Promise.all([
    required(admin.from("session_git_continuity_enrollments").select("session_id").limit(1000)),
    required(admin.from("sessions").select("id").is("pipeline_id", null).limit(1000)),
  ]);
  // The global claim RPC can select fresh enrolled sessions and non-pipeline
  // work. Unenrolled legacy pipeline seed jobs cannot pass its release gate.
  assert.ok(enrollments.length < 1000 && nonPipeline.length < 1000);
  const eligibleSessionIds = [
    ...new Set([...enrollments.map((row) => row.session_id), ...nonPipeline.map((row) => row.id)]),
  ];
  if (eligibleSessionIds.length) {
    const active = await required(
      admin
        .from("agent_jobs")
        .select("id")
        .in("status", ["queued", "started", "running"])
        .in("session_id", eligibleSessionIds)
        .limit(1),
    );
    assert.equal(active.length, 0);
  }
  const priorGate = await getGate(context);
  let ownedGate: Gate | undefined;
  const root = await mkdtemp(join(tmpdir(), "wallie-continuity-release-"));
  const manifestPath = join(root, "manifest.json");
  let outcome: Record<string, unknown> | undefined;
  let restoration: Gate | undefined;
  const fixtureRunId = randomUUID();
  const baseBranch = `wallie/continuity-fixture/${fixtureRunId}/base`;
  const driftBranch = `wallie/continuity-fixture/${fixtureRunId}/default-drift`;
  let databaseDefaultChanged = false;
  try {
    phase = "enable-local-release-gate";
    ownedGate = priorGate.enabled
      ? priorGate
      : await setGate(
          context,
          true,
          priorGate.revision,
          "Isolated OP-499 real-provider release smoke",
        );
    assert.equal(ownedGate.enabled, true);
    const source = join(root, "source");
    const gitEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${context.githubToken}`).toString("base64")}`,
      GIT_AUTHOR_NAME: "Wallie",
      GIT_AUTHOR_EMAIL: "noreply@wallie.dev",
      GIT_AUTHOR_DATE: "946684800 +0000",
      GIT_COMMITTER_NAME: "Wallie",
      GIT_COMMITTER_EMAIL: "noreply@wallie.dev",
      GIT_COMMITTER_DATE: "946684800 +0000",
    };
    const git = async (arguments_: string[]) => {
      if (arguments_.includes("push"))
        assertOwnedPush(arguments_, [`refs/heads/${baseBranch}`, `refs/heads/${driftBranch}`]);
      return (
        await exec("git", arguments_, {
          env: gitEnv,
          signal: context.signal,
          maxBuffer: 1024 * 1024,
          timeout: 45_000,
        })
      ).stdout.trim();
    };
    phase = "initialize-owned-source-fixture";
    const remoteUrl = `https://github.com/${repository}.git`;
    const readRemoteRefs = async () =>
      new Map(
        (await git(["ls-remote", "--refs", remoteUrl]))
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [sha, ref] = line.split(/\s+/);
            return [ref, sha] as const;
          }),
      );
    const preservedRefs = await readRemoteRefs();
    type PullSnapshot = {
      number: number;
      state: string;
      draft: boolean;
      head: { sha: string; ref: string };
      base: { ref: string };
    };
    const readPullSnapshots = async () => {
      const pulls: PullSnapshot[] = [];
      for (let page = 1; page <= 100; page++) {
        const next = await context.github<PullSnapshot[]>(
          `/pulls?state=all&per_page=100&page=${page}`,
        );
        pulls.push(...next);
        if (next.length < 100) break;
        assert.ok(page < 100);
      }
      return pulls;
    };
    const existingPulls = await readPullSnapshots();
    const preservePull = (pull: PullSnapshot) => ({
      number: pull.number,
      state: pull.state,
      draft: pull.draft,
      headSha: pull.head.sha,
      headRef: pull.head.ref,
      baseRef: pull.base.ref,
    });
    const preservedPulls = existingPulls.map(preservePull);
    await git(["init", "-q", `--initial-branch=${baseBranch}`, source]);
    await writeFile(
      join(source, "README.md"),
      `# Controlled continuity release fixture\n\nRun: ${fixtureRunId}\n`,
    );
    await writeFile(
      join(source, "vercel.json"),
      JSON.stringify({ git: { deploymentEnabled: false } }) + "\n",
    );
    await git(["-C", source, "add", "README.md", "vercel.json"]);
    await git(["-C", source, "commit", "-qm", "Initial continuity fixture"]);
    const initialBaseSha = await git(["-C", source, "rev-parse", "HEAD"]);
    await git([
      "-C",
      source,
      "push",
      `--force-with-lease=refs/heads/${baseBranch}:`,
      remoteUrl,
      `${initialBaseSha}:refs/heads/${baseBranch}`,
    ]);
    databaseDefaultChanged = true;
    await required(
      admin
        .from("github_repositories")
        .update({ default_branch: baseBranch })
        .eq("id", identity.repositoryId)
        .eq("workspace_id", identity.workspaceId)
        .select("id")
        .single(),
    );
    phase = "create-enrolled-session";
    const pipeline = await required(
      admin
        .from("pipelines")
        .insert({ workspace_id: identity.workspaceId, name: `Continuity release ${randomUUID()}` })
        .select("id")
        .single(),
    );
    await required(
      admin
        .from("pipeline_stages")
        .insert(
          ["plan", "build", "verify"].map((slug, index) => ({
            pipeline_id: pipeline.id,
            workspace_id: identity.workspaceId,
            position: index + 1,
            slug,
            name: slug,
            prompt_template_md: `Controlled ${slug} fixture`,
          })),
        )
        .select("id"),
    );
    const session = (
      await required(
        admin.rpc("create_session_with_first_job", {
          target_workspace_id: identity.workspaceId,
          creator_member_id: identity.memberId,
          session_title: "Controlled continuity release smoke",
          session_prompt_md: "Exercise durable source continuity with deterministic fixture edits.",
          agent_model_provider: "codex",
          agent_model_name: "deterministic-release-smoke",
          session_github_repository_id: identity.repositoryId,
          selected_pipeline_id: pipeline.id,
        }),
      )
    )[0];
    const enrolled = await required(
      context.control
        .from("session_git_continuity_enrollments")
        .select("session_id,workspace_id")
        .eq("session_id", session.session_id)
        .single(),
    );
    assert.equal(enrolled.workspace_id, identity.workspaceId);
    let manifest: Manifest = {
      format: 1,
      ...identity,
      repository,
      repositoryNumericId: metadata.id,
      fixtureRunId,
      baseBranch,
      databaseWorkdir,
      vercelEnvFile,
      initialBaseSha,
      pipelineId: pipeline.id,
      sessionId: session.session_id,
      nextJobId: session.job_id,
      releaseRevision: ownedGate.revision,
      evidence: [],
    };
    await saveManifest(manifestPath, manifest);
    const runChild = async (kind: "produce" | "recover-publication", label: Label) => {
      phase = `${kind}-${label}`;
      // Credentials are acquired inside each fresh process, never serialized in argv.
      let child;
      try {
        child = await exec(
          process.execPath,
          [
            ...process.execArgv,
            script,
            "--execute",
            "--worker",
            kind,
            "--label",
            label,
            "--manifest",
            manifestPath,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, WALLIE_CONTINUITY_SMOKE_CHILD: "1" },
            timeout: 300_000,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch (error) {
        // Accept only our fixed failure schema, never relay raw child stderr.
        try {
          const stderr = (error as { stderr?: unknown }).stderr;
          if (typeof stderr === "string") {
            const receipt = JSON.parse(stderr.trim().split("\n").at(-1)!);
            if (
              receipt.status === "failed" &&
              typeof receipt.phase === "string" &&
              /^worker-[a-z-]+$/.test(receipt.phase) &&
              Array.isArray(receipt.providerReceipts)
            ) {
              const clean = receipt.providerReceipts
                .filter((item: unknown): item is (typeof providerReceipts)[number] => {
                  if (!item || typeof item !== "object") return false;
                  const record = item as Record<string, unknown>;
                  return (
                    typeof record.sandboxId === "string" &&
                    /^[A-Za-z0-9_-]+$/.test(record.sandboxId) &&
                    typeof record.stopped === "boolean" &&
                    (record.sourceAvailable === null || typeof record.sourceAvailable === "boolean")
                  );
                })
                .map((item: (typeof providerReceipts)[number]) => ({
                  sandboxId: item.sandboxId,
                  stopped: item.stopped,
                  sourceAvailable: item.sourceAvailable,
                }));
              childFailure = {
                phase: receipt.phase,
                ...(typeof receipt.step === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(receipt.step)
                  ? { step: receipt.step }
                  : {}),
                providerReceipts: clean,
              };
            }
          }
        } catch {
          /* The child outcome remains unconfirmed. */
        }
        throw new Error("Smoke child worker failed.");
      }
      const safeReceipt = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
        status: string;
        pid: number;
      };
      assert.equal(safeReceipt.status, "worker-passed");
      assert.notEqual(safeReceipt.pid, process.pid);
      manifest = await readManifest(manifestPath);
    };
    await runChild("produce", "plan");
    await decide(context, manifest, "approve");
    await saveManifest(manifestPath, manifest);
    // Move only this run's base and local fixture binding after plan is pinned.
    // Existing GitHub branches and repository default configuration stay intact.
    await writeFile(
      join(source, "default-drift.txt"),
      "Moving default must not enter the selected checkpoint.\n",
    );
    await git(["-C", source, "add", "default-drift.txt"]);
    await git(["-C", source, "commit", "-qm", "Deliberate default branch drift"]);
    const movedDefaultSha = await git(["-C", source, "rev-parse", "HEAD"]);
    await git([
      "-C",
      source,
      "push",
      "--atomic",
      `--force-with-lease=refs/heads/${baseBranch}:${initialBaseSha}`,
      `--force-with-lease=refs/heads/${driftBranch}:`,
      remoteUrl,
      `${movedDefaultSha}:refs/heads/${baseBranch}`,
      `${movedDefaultSha}:refs/heads/${driftBranch}`,
    ]);
    await required(
      admin
        .from("github_repositories")
        .update({ default_branch: driftBranch })
        .eq("id", identity.repositoryId)
        .eq("default_branch", baseBranch)
        .select("id")
        .single(),
    );
    await runChild("produce", "build");
    await decide(context, manifest, "reject");
    await saveManifest(manifestPath, manifest);
    await runChild("produce", "revision");
    phase = "verify-durable-pending-restart-boundary";
    const revision = manifest.evidence.at(-1)!;
    assert.equal(revision.artifactId, undefined);
    assert.equal(revision.cleanup.length, 1);
    const pending = await required(
      admin
        .from("session_checkpoint_publications")
        .select("status,artifact_md")
        .eq("run_id", revision.runId)
        .single(),
    );
    assert.equal(pending.status, "pending");
    assert.ok(pending.artifact_md.includes("revision"));
    assert.equal(
      (
        await required(
          admin.from("session_artifacts").select("id").eq("session_id", manifest.sessionId),
        )
      ).length,
      2,
    );
    assert.equal(
      (
        await required(
          admin.from("session_git_checkpoints").select("run_id").eq("run_id", revision.runId),
        )
      ).length,
      0,
    );
    await runChild("recover-publication", "revision");
    assert.notEqual(
      manifest.evidence.at(-1)!.workerPid,
      manifest.evidence.at(-1)!.publicationWorkerPid,
    );
    await decide(context, manifest, "approve");
    await saveManifest(manifestPath, manifest);
    await runChild("produce", "verify");
    phase = "final-stage-count";
    assert.equal(manifest.evidence.length, 4);
    const [plan, build, revised, verify] = manifest.evidence;
    phase = "final-sha-lineage";
    assert.equal(build.inputSha, plan.outputSha);
    assert.equal(revised.inputSha, build.outputSha);
    assert.equal(verify.inputSha, revised.outputSha);
    assert.equal(verify.outputSha, revised.outputSha);
    phase = "final-no-code-provenance";
    // A no-code checkpoint creates no output ref. Its selected input carries
    // the previous code-bearing checkpoint's retained ref and exact SHA.
    assert.equal(verify.outputRef, undefined);
    assert.equal(verify.inputRef, revised.outputRef);
    assert.equal(verify.sourceCheckpointRunId, revised.runId);
    assert.equal(verify.bundleBytes, 0);
    phase = "final-provider-cleanup-and-base-lineage";
    for (const evidence of manifest.evidence) {
      assert.equal(evidence.initialBaseSha, initialBaseSha);
      assert.notEqual(evidence.observedBeforeSha, movedDefaultSha);
      assert.equal(evidence.canonical!.prNumber, plan.canonical!.prNumber);
      assert.equal(evidence.canonical!.epochId, plan.canonical!.epochId);
      assert.ok(evidence.cleanup.length >= 2);
    }
    assert.equal(new Set(manifest.evidence.map((evidence) => evidence.workerPid)).size, 4);
    phase = "final-canonical-pr-identity";
    const epoch = await required(
      admin
        .from("session_pr_epochs")
        .select("branch_name,base_branch")
        .eq("id", plan.canonical!.epochId)
        .single(),
    );
    assert.equal(epoch.base_branch, baseBranch);
    const pulls = await context.github<Array<{ number: number }>>(
      `/pulls?state=all&per_page=100&head=${encodeURIComponent(`${repository.split("/")[0]}:${epoch.branch_name}`)}`,
    );
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].number, plan.canonical!.prNumber);
    phase = "final-preexisting-refs";
    const currentRefs = await readRemoteRefs();
    concurrentChanges = { refs: [], pullRequests: [], defaultBranch: false };
    for (const [ref, sha] of preservedRefs)
      if (currentRefs.get(ref) !== sha) concurrentChanges.refs.push(ref);
    phase = "final-preexisting-pull-requests";
    const currentPulls = new Map(
      (await readPullSnapshots()).map((pull) => [pull.number, preservePull(pull)]),
    );
    for (const prior of preservedPulls) {
      if (JSON.stringify(currentPulls.get(prior.number)) !== JSON.stringify(prior))
        concurrentChanges.pullRequests.push(prior.number);
    }
    phase = "final-repository-default";
    const currentMetadata = await context.github<{ default_branch: string }>("");
    concurrentChanges.defaultBranch = currentMetadata.default_branch !== metadata.default_branch;
    // Our transports reject all writes outside new owned refs. A concurrent
    // actor may still update existing state: report it and stop, never restore it.
    phase = "final-concurrent-change-check";
    assert.equal(
      concurrentChanges.refs.length +
        concurrentChanges.pullRequests.length +
        Number(concurrentChanges.defaultBranch),
      0,
    );
    outcome = {
      status: "passed",
      repository,
      repositoryUrl: `https://github.com/${repository}`,
      fixtureRunId,
      baseBranch,
      driftBranch,
      ...identity,
      sessionId: manifest.sessionId,
      pipelineId: pipeline.id,
      releaseRevision: ownedGate.revision,
      initialBaseSha,
      movedDefaultSha,
      evidence: manifest.evidence,
      execution:
        "Actual local lifecycle RPCs; real Vercel/GitHub; deterministic runner and manual trusted transport, not production daemon or LLM",
      invariants: {
        planToBuild: true,
        requestChangesToReviewedCode: true,
        revisedBuildToNextStage: true,
        noCodePreservesInputRefWithoutNewOutputRef: true,
        oneCanonicalPullRequest: true,
        freshProcessInputRestore: true,
        freshProcessDurablePublicationRecovery: true,
        producerSandboxDestroyedBeforeRecovery: true,
        preexistingRefsPreserved: true,
        preexistingPullRequestsPreserved: true,
        remoteDefaultBranchUnchanged: true,
        transportWritesRestrictedToOwnedRefs: true,
      },
      deployment: {
        sourceGitDeploymentsDisabled: true,
        fenceCheckAttemptPossible: true,
        manualDeploymentPerformed: false,
        projectSettingsChanged: false,
      },
    };
  } finally {
    const priorPhase = phase;
    if (outcome === undefined) {
      try {
        partialEvidence = sanitizedManifestEvidence(await readManifest(manifestPath));
        const evidenceDirectory = await mkdtemp(
          join(tmpdir(), "wallie-continuity-failure-evidence-"),
        );
        retainedEvidenceFile = join(evidenceDirectory, "evidence.json");
        await writeFile(
          retainedEvidenceFile,
          JSON.stringify({
            phase: priorPhase,
            evidence: partialEvidence,
            childFailure,
            concurrentChanges,
          }),
          { mode: 0o600 },
        );
      } catch {
        /* Cleanup still runs if a partial manifest is unavailable. */
      }
    }
    phase = "restore-local-release-gate-and-cleanup";
    try {
      try {
        if (databaseDefaultChanged) {
          const restored = await admin
            .from("github_repositories")
            .update({ default_branch: binding.default_branch })
            .eq("id", identity.repositoryId)
            .eq("workspace_id", identity.workspaceId)
            .in("default_branch", [baseBranch, driftBranch])
            .select("id");
          if (restored.error) throw new Error("Local fixture default restoration failed.");
          const current = await required(
            admin
              .from("github_repositories")
              .select("default_branch")
              .eq("id", identity.repositoryId)
              .single(),
          );
          assert.equal(current.default_branch, binding.default_branch);
        }
      } finally {
        if (ownedGate && !priorGate.enabled)
          restoration = await setGate(
            context,
            priorGate.enabled,
            ownedGate.revision,
            priorGate.reason,
          );
        else restoration = await getGate(context);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    phase = priorPhase;
  }
  phase = "completed";
  assert.equal(restoration?.enabled, priorGate.enabled);
  console.log(
    JSON.stringify({
      ...outcome,
      releaseGateRestored: restoration?.enabled === priorGate.enabled,
      restoredReleaseRevision: restoration?.revision,
      localTemporaryFiles: "removed",
      githubAndLocalDatabaseEvidence: "preserved",
    }),
  );
}

void main().catch(() => {
  // Process, transport and database errors may embed tokens or private bundles.
  console.error(
    JSON.stringify({
      status: "failed",
      repository: repositoryForFailure,
      phase,
      step: getRuntimeStep(),
      childFailure,
      providerReceipts,
      concurrentChanges,
      partialEvidence,
      retainedEvidenceFile,
      error: "continuity-release-smoke-failed",
      history: "preserved; inspect the isolated fixture before retrying",
    }),
  );
  process.exitCode = 1;
});
