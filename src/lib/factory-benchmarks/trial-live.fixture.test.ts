import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { compiledFactoryDefinitionSchema } from "@/lib/factory-definitions/schema";
import { SOURCE_CHECKPOINT_BUCKET, SOURCE_CHECKPOINT_REF } from "@/lib/pipeline/source-checkpoint";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import { hasRecoverableSandboxSource } from "@/lib/sandbox";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import type { Database } from "@/lib/supabase/database.types";
import { saveVercelSandboxConnection } from "@/lib/vercel-sandbox/server";
import { parseWorkerConfig } from "@/worker/config";
import { claimNextJob, runClaimedJob } from "@/worker/loop";

import { replaySha256 } from "./replay-contracts";

vi.mock("@/features/github/sandbox-token", () => ({ mintSandboxRepositoryToken: vi.fn() }));

const workdir = process.env.WALLIE_BENCHMARK_TRIAL_SMOKE_WORKDIR;
const repository = "anantjain-xyz/wallie-dev";
const commitSha = "538c7db75b663a795d8ce6fde06b98b4d42ed3e4";
const retainedRef = `refs/heads/wallie/checkpoints/5ba156cc-ba2e-40a8-87e8-29e383ef815d/${commitSha}`;
const title = "Count archived README lines";
const prompt = "Count the lines in the README.md at the supplied checkout.";
const agentPrompt = "Record a measured result.";

function readResult<T>({ data, error }: { data: T; error: { message: string } | null }) {
  if (error) throw new Error(error.message);
  if (data == null) throw new Error("The fixture expected a database receipt.");
  return data;
}

function loopbackProject(directory: string) {
  const status = z
    .object({
      API_URL: z.string().url(),
      DB_URL: z.string().url(),
      SERVICE_ROLE_KEY: z.string().optional(),
      SECRET_KEY: z.string().optional(),
    })
    .parse(
      JSON.parse(
        execFileSync("supabase", ["status", "--workdir", directory, "--output", "json"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15_000,
        }),
      ),
    );
  const dbUrl = new URL(status.DB_URL);
  for (const endpoint of [new URL(status.API_URL), dbUrl]) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
      throw new Error("Benchmark trial smoke requires a disposable loopback Supabase project.");
    }
  }
  const serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  if (!serviceKey) throw new Error("The local project's service key is unavailable.");
  const admin = createClient<Database>(status.API_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const sql = (args: string[]) =>
    execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", ...args], {
      env: {
        ...process.env,
        PGHOST: dbUrl.hostname,
        PGPORT: dbUrl.port,
        PGDATABASE: dbUrl.pathname.slice(1),
        PGUSER: decodeURIComponent(dbUrl.username),
        PGPASSWORD: decodeURIComponent(dbUrl.password),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  return { admin, sql };
}

it.skipIf(!workdir)(
  "retains one isolated Node trial from a public Wallie archive in real Vercel",
  async () => {
    if (!workdir) throw new Error("Missing disposable database workdir.");
    const token = process.env.VERCEL_TOKEN;
    const teamId = process.env.VERCEL_TEAM_ID;
    const projectId = process.env.VERCEL_PROJECT_ID;
    if (!token || !teamId || !projectId) throw new Error("Missing Vercel smoke credentials.");
    const { admin, sql } = loopbackProject(workdir);
    const namespace = randomUUID().split("-")[0];
    const fixtureId = (slot: number) =>
      `${namespace}-0000-4000-8000-${String(slot).padStart(12, "0")}`;
    const workspaceId = fixtureId(2);
    const actorUserId = fixtureId(1);
    const smokeDirectory = mkdtempSync(join(tmpdir(), "wallie-trial-proof-"));
    const request = globalThis.fetch.bind(globalThis);
    let checkpointPath: string | undefined;
    let trialRunId: string | undefined;
    let seeded = false;
    try {
      vi.stubEnv("WALLIE_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
      vi.stubEnv("WALLIE_SANDBOX_IMPL", "vercel");
      const metadata = await request(`https://api.github.com/repos/${repository}`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      expect(metadata.ok).toBe(true);
      const repo = z
        .object({
          id: z.number().int().positive(),
          full_name: z.literal(repository),
          private: z.literal(false),
        })
        .parse(await metadata.json());
      const installationId = 616_000_000_000 + Number.parseInt(namespace, 16);
      vi.mocked(mintSandboxRepositoryToken).mockImplementation(async (input) => {
        expect(input.repositoryFullName).toBe(repository);
        expect(input.repositoryId).toBe(repo.id);
        expect(input.installationId).toBe(installationId);
        expect(["benchmark-checkout", "read-context"]).toContain(input.purpose);
        return "";
      });
      const refPath = `https://api.github.com/repositories/${repo.id}/git/ref/${retainedRef.slice(5)}`;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== refPath) return request(input, init);
        expect(init?.method ?? "GET").toBe("GET");
        const headers = new Headers(init?.headers);
        headers.delete("Authorization");
        return request(url, { ...init, headers });
      });

      const definition = compiledFactoryDefinitionSchema.parse({
        schemaVersion: 1,
        kind: "serial",
        sandboxProvider: "vercel",
        agent: {
          provider: "codex",
          model: "gpt-5.5",
          effort: null,
          concurrencyLimit: 2,
          stallTimeoutMs: 90_000,
          maxRetries: 0,
          maxTurns: 4,
        },
        implementationAgent: {
          agentId: fixtureId(8),
          promptRevisionId: fixtureId(9),
          promptMd: agentPrompt,
          promptSha256: replaySha256(agentPrompt),
        },
        pipelineId: fixtureId(6),
        repositoryId: fixtureId(5),
        skillIds: [],
        toolIds: [],
        executionPolicyRevisionId: null,
        deliveryPolicyRevisionId: null,
        operatingRulesMd: "",
        operatingRuleStageIds: [],
        stages: [
          {
            id: fixtureId(7),
            slug: "run",
            name: "Run",
            description: "",
            promptTemplateMd: "{{session.prompt}}",
            anyoneCanApprove: true,
            approverMemberIds: [],
            previousStageIds: [],
          },
        ],
      });
      const required = [
        ["session/title", title],
        ["session/prompt", prompt],
      ].map(([key, body]) => ({ key, ...fingerprintRunContextInput(body) }));
      const size = required.reduce((sum, input) => sum + input.utf8Bytes, 0);
      const contextManifest = JSON.stringify({
        version: 1,
        required,
        documents: [],
        conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
        budget: {
          maxUtf8Bytes: 131072,
          maxEstimatedTokens: 32768,
          usedUtf8Bytes: size,
          estimatedTokens: size,
        },
      });
      const seedOptions = {
        namespace,
        prompt,
        installation_id: installationId,
        repository_id: repo.id,
        retained_ref: retainedRef,
        definition: JSON.stringify(definition),
        context_manifest: contextManifest,
        commit_sha: commitSha,
        fixture_email: `benchmark-trial-${namespace}@example.test`,
        fixture_slug: `benchmark-trial-${namespace}`,
      };
      sql([
        ...Object.entries(seedOptions).map(([key, value]) => `--set=${key}=${value}`),
        "--file",
        fileURLToPath(new URL("../../../test/release/benchmark-trial-source.sql", import.meta.url)),
      ]);
      seeded = true;

      const factory = readResult(
        await admin
          .from("factories")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("is_default", true)
          .single(),
      );
      const scope = {
        p_workspace_id: workspaceId,
        p_factory_id: factory.id,
        p_actor_user_id: actorUserId,
      };
      await saveVercelSandboxConnection({
        admin,
        credentials: { token, teamId, projectId },
        workspaceId,
        createdByMemberId: fixtureId(3),
        projectName: "Disposable benchmark test",
      });
      const { connection } = await loadRequiredWorkspaceSandboxConnection(
        admin,
        workspaceId,
        "vercel",
      );
      const captured = z.object({ taskRevisionId: z.string().uuid() }).parse(
        readResult(
          await admin.rpc("capture_factory_benchmark_run", {
            ...scope,
            p_source_run_id: fixtureId(13),
            p_acceptance_criteria: "Record three README lines in a private commit.",
            p_task_name: title,
            p_replay_eligibility: "eligible",
            p_suite_id: fixtureId(15),
            p_new_suite_name: "Archive qualification",
            p_new_suite_purpose: "regression",
          }),
        ),
      );
      const body = JSON.stringify({
        version: 1,
        operation: "count_utf8_lines",
        promptSha256: replaySha256(prompt),
        checkoutSha: commitSha,
        sourcePath: "README.md",
        expectedLineCount: 3,
      });
      const fixtureKey = replaySha256("read the public archive qualification fixture");
      const [fixture] = readResult(
        await admin.rpc("publish_factory_benchmark_replay_fixture", {
          ...scope,
          p_operation: "tool_read",
          p_fixture_key: fixtureKey,
          p_response_json: body,
        }),
      );
      const policy = readResult(
        await admin.rpc("publish_factory_benchmark_replay_policy", {
          ...scope,
          p_profile: "recorded_fixtures",
          p_fixture_revision_ids: [fixture.id],
        }),
      );
      const trial = readResult(
        await admin.rpc("admit_factory_benchmark_trial", {
          ...scope,
          p_trial_id: fixtureId(14),
          p_task_revision_id: captured.taskRevisionId,
          p_policy_revision_id: policy.id,
          p_policy_digest: policy.policy_digest,
          p_fixture_key: fixtureKey,
          p_sandbox_connection_revision: connection.revision,
        }),
      );
      trialRunId = trial.run_id;
      // Choose this disposable fixture before any demo-seed queue entries.
      const ordered = await admin
        .from("agent_jobs")
        .update({ created_at: "2000-01-01T00:00:00.000Z" })
        .eq("id", trial.job_id);
      expect(ordered.error).toBeNull();
      const claim = await claimNextJob(admin, parseWorkerConfig());
      expect(claim.outcome).toBe("claimed");
      if (claim.outcome !== "claimed")
        throw new Error("The benchmark fixture is unavailable to claim.");
      expect(claim.job.id).toBe(trial.job_id);
      await runClaimedJob(admin, claim.job, {
        timeoutMs: 180_000,
        workerRuntime: "node",
        captureOrderedEvents: false,
      });

      const fresh = readResult(
        await admin.from("factory_benchmark_trials").select("*").eq("id", trial.id).single(),
      );
      const run = readResult(
        await admin.from("agent_runs").select("*").eq("id", trial.run_id).single(),
      );
      expect(fresh.status, `run failure: ${fresh.failure_code}`).toBe("success");
      const result = readResult(
        await admin
          .from("factory_benchmark_trial_results")
          .select("*")
          .eq("trial_id", trial.id)
          .single(),
      );
      const path = result.checkpoint_storage_path;
      checkpointPath = path;
      expect(result.input_commit_sha).toBe(commitSha);
      expect(result.output_commit_sha).not.toBe(commitSha);
      expect(result.artifact_markdown).toBe("Counted 3 lines in `README.md`.");
      expect(result.validation).toMatchObject({
        status: "passed",
        commitSha: result.output_commit_sha,
        treeSha: result.output_tree_sha,
      });
      expect(run.input_tokens).toBeNull();
      expect(run.output_tokens).toBeNull();
      expect(run.total_cost_usd).toBeNull();
      const prematureRemoval = await admin.storage.from(SOURCE_CHECKPOINT_BUCKET).remove([path]);
      expect(prematureRemoval.error).not.toBeNull();
      const bundle = Buffer.from(
        await readResult(
          await admin.storage.from(SOURCE_CHECKPOINT_BUCKET).download(path),
        ).arrayBuffer(),
      );
      expect(replaySha256(bundle)).toBe(result.checkpoint_bundle_sha256);
      const bundleFile = join(smokeDirectory, "trial.bundle");
      writeFileSync(bundleFile, bundle, { mode: 0o600 });
      expect(
        execFileSync("git", ["bundle", "list-heads", bundleFile], { encoding: "utf8" }).trim(),
      ).toBe(`${result.output_commit_sha} ${SOURCE_CHECKPOINT_REF}`);
      const pushed = await admin
        .from("session_pull_requests")
        .select("id", { count: "exact", head: true })
        .eq("session_id", trial.session_id);
      expect(pushed.count).toBe(0);
      expect(run.sandbox_id).toBeTruthy();
      expect(await hasRecoverableSandboxSource(run.sandbox_id!, connection)).toBe(false);
      process.stdout.write(
        JSON.stringify({
          trialId: trial.id,
          runId: trial.run_id,
          sandboxId: run.sandbox_id,
          sourceCommit: result.input_commit_sha,
          outputCommit: result.output_commit_sha,
          restorationReceiptSha256: result.restoration_receipt_sha256,
          inputBundleSha256: result.input_bundle_sha256,
          fixtureResponseSha256: result.fixture_response_sha256,
          resultDigest: result.result_digest,
          checkpointSha256: result.checkpoint_bundle_sha256,
          validation: result.validation,
          activeCheckpointDeletionDenied: true,
          productionPullRequests: 0,
          sourceRemoved: true,
          githubRead: "anonymous-public-fixture",
        }) + "\n",
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(smokeDirectory, { recursive: true, force: true });
      if (seeded) {
        sql([
          "--command",
          `update public.workspaces set deletion_requested_at = clock_timestamp() where id = '${workspaceId}';`,
        ]);
        if (!checkpointPath && trialRunId) {
          const prefix = `${workspaceId}/benchmark/${fixtureId(14)}/${trialRunId}`;
          const files = await admin.storage.from(SOURCE_CHECKPOINT_BUCKET).list(prefix);
          if (files.data?.length)
            await admin.storage
              .from(SOURCE_CHECKPOINT_BUCKET)
              .remove(files.data.map(({ name }) => `${prefix}/${name}`));
        }
        if (checkpointPath) {
          const removed = await admin.storage
            .from(SOURCE_CHECKPOINT_BUCKET)
            .remove([checkpointPath]);
          expect(removed.error).toBeNull();
          const retained = await admin.storage
            .from(SOURCE_CHECKPOINT_BUCKET)
            .exists(checkpointPath);
          expect(retained.data).toBe(false);
        }
        sql([
          "--command",
          `delete from public.workspaces where id = '${workspaceId}'; delete from auth.users where id = '${actorUserId}';`,
        ]);
      }
    }
  },
  240_000,
);
