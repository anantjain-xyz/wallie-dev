import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod/v4";

import type { ActionsDeliveryOperation } from "@/lib/factory-delivery-commands/actions-contract";
import { actionsNumericId } from "@/lib/factory-delivery-commands/actions-contract";
import type { dispatchActionsDelivery } from "@/features/github/actions-delivery";

const api = "https://api.github.com";
const repo = "anantjain-xyz/wallie-dev";
const repoPath = `/repos/${repo}`;
const fixtureWorkflowId = 428339459;
const fixtureWorkflowPath = ".github/workflows/wallie-delivery-fixture.yml";
const fixtureRepositoryId = 1196742316;
// Only the reviewed workflow blob is allowed to run. Its job records a marker
// without checking out the tag's repository code or gaining write permissions.
const fixtureWorkflowBlob = "f36edafa02b3d12b2f238a1f4d6900b74f3d7845";
export const fixtureEnvironment = "wallie-m12-fixture";
export const fixtureTagSchema = z.string().regex(/^wallie-m12-fixture-[A-Za-z0-9-]{8,72}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);

function githubHeaders(credential: string) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "wallie-m12-release-fixture",
    "x-github-api-version": "2026-03-10",
    authorization: `Bearer ${credential}`,
  };
}

export async function openLiveGitHubFixture(rawTag: string) {
  const tag = fixtureTagSchema.parse(rawTag);
  const credential = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
  assert(credential, "Authenticate gh for the authorized smoke repository first.");

  async function read<T>(path: string, schema: z.ZodType<T>) {
    const response = await fetch(api + path, {
      headers: githubHeaders(credential),
      signal: AbortSignal.timeout(12_000),
      redirect: "manual",
    });
    assert.equal(
      response.status,
      200,
      `Unable to read the exact GitHub fixture (${response.status}).`,
    );
    return schema.parse(await response.json());
  }

  const [identity, workflow, reference, actor] = await Promise.all([
    read(repoPath, z.object({ id: z.literal(fixtureRepositoryId), full_name: z.literal(repo) })),
    read(
      `${repoPath}/actions/workflows/${fixtureWorkflowId}`,
      z.object({
        id: z.literal(fixtureWorkflowId),
        path: z.literal(fixtureWorkflowPath),
        state: z.literal("active"),
      }),
    ),
    read(
      `${repoPath}/git/ref/tags/${tag}`,
      z.object({
        ref: z.literal(`refs/tags/${tag}`),
        object: z.object({ type: z.literal("commit"), sha }),
      }),
    ),
    read("/user", z.object({ login: z.string().min(1) })),
  ]);
  const sourceRevision = reference.object.sha;
  const dispatchPath = `${repoPath}/actions/workflows/${workflow.id}/dispatches`;
  const filePath = `${repoPath}/contents/${workflow.path}`;
  const lookupPath = `${repoPath}/actions/workflows/${workflow.id}/runs`;
  const tagPath = `${repoPath}/git/ref/tags/${tag}`;
  const releasePath = `${repoPath}/releases/tags/${tag}`;
  const runUrl = (id: number) => `https://github.com/${repo}/actions/runs/${id}`;
  const [workflowFile, existingRuns] = await Promise.all([
    read(`${filePath}?ref=${sourceRevision}`, z.object({ type: z.literal("file"), sha })),
    read(
      `${lookupPath}?branch=${tag}&event=workflow_dispatch&per_page=1`,
      z.object({ total_count: z.number().int().nonnegative() }),
    ),
  ]);
  assert.equal(
    workflowFile.sha,
    fixtureWorkflowBlob,
    "The tagged workflow is not the smoke fixture.",
  );
  assert.equal(existingRuns.total_count, 0, "Use a fresh tag; this fixture tag already has a run.");
  let sent = 0;
  let droppedRunId: number | undefined;

  function transport(
    target: ActionsDeliveryOperation,
  ): Pick<Parameters<typeof dispatchActionsDelivery>[0], "fetcher" | "mintToken"> {
    assert.equal(target.repositoryNumericId, identity.id);
    assert.equal(target.repositoryFullName, identity.full_name);
    assert.equal(target.workflowId, workflow.id);
    assert.equal(target.workflowPath, workflow.path);
    assert.equal(target.tag, tag);
    assert.equal(target.environment, fixtureEnvironment);
    assert.equal(target.sourceRevision, sourceRevision);
    return {
      mintToken: async (request) => {
        assert.equal(request.installationId, target.installationId);
        assert.equal(request.repositoryNumericId, fixtureRepositoryId);
        return { kind: "granted", token: credential, actorLogin: actor.login };
      },
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, api);
        assert.equal(init?.redirect, "manual");
        assert(
          new Headers(init?.headers).get("authorization") === `Bearer ${credential}`,
          "Fixture credential changed.",
        );
        if (init?.method === "POST") {
          assert.equal(url.pathname + url.search, dispatchPath);
          const body = z
            .object({ ref: z.string(), inputs: z.record(z.string(), z.string()) })
            .parse(JSON.parse(String(init.body)));
          assert.deepEqual(body, {
            ref: `refs/tags/${tag}`,
            inputs: {
              wallie_command_id: target.commandId,
              wallie_source_sha: sourceRevision,
              wallie_environment: fixtureEnvironment,
              wallie_run_nonce: target.runNonce,
            },
          });
          assert.equal(++sent, 1, "A lost response must never reissue the GitHub POST.");
          const response = await fetch(url, init);
          assert.equal(
            response.status,
            200,
            "GitHub did not accept the isolated fixture dispatch.",
          );
          droppedRunId = z
            .object({ workflow_run_id: actionsNumericId })
            .parse(await response.json()).workflow_run_id;
          console.log(
            `[m12-live] Dropped the accepted dispatch response for ${runUrl(droppedRunId)}`,
          );
          throw new Error("Fixture discarded the real GitHub dispatch response.");
        }
        assert.equal(init?.method, "GET");
        if (url.pathname + url.search === releasePath) {
          // The smoke repository has immutable releases disabled. Only this read
          // is simulated. GitHub serves the exact tag, workflow, dispatch, and run.
          return Response.json({
            tag_name: tag,
            immutable: true,
            draft: false,
            published_at: new Date().toISOString(),
          });
        }
        const exactWorkflowRead =
          url.pathname === filePath && url.search === `?ref=${sourceRevision}`;
        const exactRunSearch =
          url.pathname === lookupPath &&
          url.searchParams.get("head_sha") === sourceRevision &&
          url.searchParams.get("event") === "workflow_dispatch";
        const fixedLookup = [
          repoPath,
          tagPath,
          `${repoPath}/actions/workflows/${workflow.id}`,
        ].includes(url.pathname + url.search);
        const exactRunRead =
          droppedRunId !== undefined &&
          url.pathname + url.search === `${repoPath}/actions/runs/${droppedRunId}`;
        assert(
          exactWorkflowRead || exactRunSearch || fixedLookup || exactRunRead,
          "Unrecognized fixture GitHub request.",
        );
        return fetch(url, init);
      },
    };
  }

  async function waitForEvidence(target: ActionsDeliveryOperation) {
    const runId = actionsNumericId.parse(droppedRunId);
    assert.equal(sent, 1);
    const until = Date.now() + 150_000;
    const jobSchema = z.object({
      jobs: z.array(
        z.object({
          id: actionsNumericId,
          name: z.string(),
          conclusion: z.string().nullable(),
          completed_at: z.iso.datetime({ offset: true }).nullable(),
        }),
      ),
    });
    const runSchema = z.object({
      id: actionsNumericId,
      workflow_id: actionsNumericId,
      head_sha: sha,
      repository: z.object({ id: actionsNumericId }),
      head_branch: z.string(),
      display_title: z.string(),
      event: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
    });
    const runPath = `${repoPath}/actions/runs/${runId}`;
    while (Date.now() < until) {
      const run = await read(runPath, runSchema);
      assert.equal(run.id, runId);
      assert.equal(run.repository.id, fixtureRepositoryId);
      assert.equal(run.workflow_id, fixtureWorkflowId);
      assert.equal(run.head_sha, sourceRevision);
      assert.equal(run.event, "workflow_dispatch");
      assert([tag, `refs/tags/${tag}`].includes(run.head_branch));
      if (run.status === "completed") {
        assert.equal(run.display_title, `wallie:${target.runNonce}`);
        assert.equal(run.conclusion, "success", "The actual fixture run failed.");
        const jobs = await read(`${runPath}/jobs`, jobSchema);
        assert.equal(jobs.jobs.length, 1);
        const job = jobs.jobs[0];
        assert(job && job.name === "verify" && job.conclusion === "success" && job.completed_at);
        const marker = `wallie-delivery-fixture ${target.commandId} ${sourceRevision} ${fixtureEnvironment}`;
        try {
          const log = execFileSync(
            "gh",
            ["run", "view", "--repo", `github.com/${repo}`, "--job", String(job.id), "--log"],
            {
              encoding: "utf8",
              env: {
                NODE_ENV: "test",
                PATH: process.env.PATH,
                TMPDIR: process.env.TMPDIR,
                GH_TOKEN: credential,
              },
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 15_000,
              maxBuffer: 256 * 1024,
            },
          );
          if (
            log
              .split("\n")
              .some((line) => line.trimEnd().endsWith(`\t${marker}`) || line.endsWith(` ${marker}`))
          ) {
            return {
              runId,
              completedAt: job.completed_at,
              url: runUrl(runId),
            };
          }
        } catch {
          // GitHub may publish the successful job before its logs are readable.
        }
      }
      await delay(2_000);
    }
    throw new Error("The exact GitHub fixture run and its log marker did not become available.");
  }

  return { sourceRevision, tag, transport, waitForEvidence };
}
