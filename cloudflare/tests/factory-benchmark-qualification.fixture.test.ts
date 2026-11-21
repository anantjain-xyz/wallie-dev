import assert from "node:assert/strict";

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it, vi } from "vitest";
import { z } from "zod/v4";

import {
  allowQualificationFetch,
  createQualificationClients,
  parseQualificationWitness,
  trialRow,
} from "../../test/release/factory-benchmark-qualification";

vi.mock("@/features/github/sandbox-token", () => ({
  mintSandboxRepositoryToken: async () => "",
}));

const bindings = env as typeof env & {
  WALLIE_FACTORY_RUNTIME_FIXTURE?: string;
  SESSION_ATTEMPT: Workflow<{ jobId: string; attemptCount: number; workflowId: string }>;
};
const raw = bindings.WALLIE_FACTORY_RUNTIME_FIXTURE;
const m08 = z.object({ m08Witness: z.string() }).safeParse(raw ? JSON.parse(raw) : null);

it.skipIf(!m08.success)(
  "runs the exact frozen Workerd claim and refuses a historical ref that disappeared after capture",
  async () => {
    assert(m08.success && raw);
    const { config, admin } = createQualificationClients(raw);
    const witness = parseQualificationWitness(m08.data.m08Witness);
    const expected = await trialRow(admin, witness.nativeTrialId);
    assert.equal(expected.status, "queued");
    const claim = await admin.rpc("claim_next_worker_dispatch", {
      accept_benchmark_trials: true,
      p_default_workspace_limit: 4,
      p_max_concurrent: 4,
      p_timeout_ms: 30_000,
    });
    assert.equal(claim.error, null, claim.error?.message);
    const [dispatch] = claim.data ?? [];
    assert(dispatch);
    assert.equal(dispatch.job_id, expected.job_id);
    vi.stubGlobal("fetch", allowQualificationFetch(config.url, globalThis.fetch, null));
    const id = dispatch.workflow_id;
    const instance = await introspectWorkflowInstance(bindings.SESSION_ATTEMPT, id);
    try {
      await bindings.SESSION_ATTEMPT.create({
        id,
        params: { jobId: dispatch.job_id, attemptCount: dispatch.attempt_count, workflowId: id },
      });
      await instance.waitForStatus("complete");
      const finished = await trialRow(admin, witness.nativeTrialId);
      assert.equal(finished.status, "error");
      assert.equal(finished.failure_code, "replay_unavailable");
      assert.equal(finished.attempt_count, 1);
      const result = await admin
        .from("factory_benchmark_trial_results")
        .select("trial_id")
        .eq("trial_id", witness.nativeTrialId)
        .maybeSingle();
      assert.equal(result.error, null);
      assert.equal(result.data, null);
    } finally {
      await instance.dispose();
      vi.unstubAllGlobals();
    }
  },
  45_000,
);
