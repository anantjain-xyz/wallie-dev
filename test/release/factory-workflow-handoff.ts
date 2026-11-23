import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { drainAuthoredFactoryWorkflowEntry } from "@/lib/factory-workflows/authoring-dispatch";
import type { Database } from "@/lib/supabase/database.types";

import { createFactoryRuntimeClients } from "./factory-runtime-fixture";

import {
  abandonedWorkflowLease,
  getWorkflowHandoffResult,
  readWorkflowHandoff,
  WORKFLOW_ABANDONED_EXIT,
  workflowHandoffWitness,
  type WorkflowHandoffWitness,
} from "./factory-workflow-handoff-contract";

type Client = SupabaseClient<Database>;
const uuid = z.string().uuid();
const observedClaim = abandonedWorkflowLease.extend({
  rootSessionId: uuid,
  workspaceId: uuid,
  factoryId: uuid,
  inputRunId: uuid,
  workflowDigest: z.string(),
  nodeId: z.literal("old.checkpoint"),
});
async function abandon(raw: string, witness: WorkflowHandoffWitness, abandonedPath: string) {
  const { config } = createFactoryRuntimeClients(raw);
  const origin = new URL(config.url).origin;
  const client = createClient<Database>(config.url, config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (request, options) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        assert.equal(url.origin, origin);
        const response = await fetch(request, options);
        if (url.pathname === "/rest/v1/rpc/claim_factory_workflow_authoring_dispatch") {
          assert(response.ok, `Claim returned ${response.status}.`);
          const claim = observedClaim.parse(await response.clone().json());
          assert.equal(claim.rootSessionId, witness.sessionId);
          assert.equal(claim.workspaceId, witness.workspaceId);
          assert.equal(claim.factoryId, witness.factoryId);
          assert.equal(claim.inputRunId, witness.inputRunId);
          assert.equal(claim.workflowDigest, witness.workflowDigest);
          writeFileSync(abandonedPath, JSON.stringify(abandonedWorkflowLease.parse(claim)), {
            mode: 0o600,
          });
          // Break before the Node worker observes or finishes the committed claim.
          process.exit(WORKFLOW_ABANDONED_EXIT);
        }
        return response;
      },
    },
  });
  await drainAuthoredFactoryWorkflowEntry(client);
  throw new Error("The producing process did not abandon a real claim.");
}

async function verifyAndApprove(
  admin: Client,
  witness: WorkflowHandoffWitness,
  abandonedPath: string,
) {
  const abandoned = abandonedWorkflowLease.parse(JSON.parse(readFileSync(abandonedPath, "utf8")));
  const recovered = await readWorkflowHandoff(admin, witness);
  assert.equal(recovered.execution.generation, abandoned.generation);
  assert.equal(
    recovered.occurrences.find(({ node_id }) => node_id === "old.checkpoint")?.occurrence_id,
    abandoned.occurrenceId,
  );
  assert.equal(
    getWorkflowHandoffResult(recovered, "old.checkpoint"),
    `checkpoint:${witness.inputRunId}`,
  );
  assert.equal(
    getWorkflowHandoffResult(recovered, "check.policy"),
    `policy:${witness.policyRevisionId}`,
  );
  assert(recovered.occurrences.some(({ node_id }) => node_id === "human.review"));
  assert.equal(getWorkflowHandoffResult(recovered, "human.review"), null);

  const stale = await admin.rpc("finish_factory_workflow_authoring_dispatch", {
    p_session_id: witness.sessionId,
    p_input_run_id: witness.inputRunId,
    p_lease_id: abandoned.leaseId,
    p_expected_generation: abandoned.generation,
  });
  assert(!stale.error, stale.error?.message);
  assert.equal(stale.data, "stale");

  const review = {
    session_id: witness.sessionId,
    workspace_id: witness.workspaceId,
    artifact_id: witness.artifactId,
    artifact_version: witness.artifactVersion,
    stage_id: witness.stageId,
  };
  const before = await admin.from("session_stage_approval_receipts").select("id").match(review);
  assert(!before.error, before.error?.message);
  assert.deepEqual(before.data, []);

  const approved = await admin.rpc("approve_session_stage", {
    target_session_id: witness.sessionId,
    expected_workspace_id: witness.workspaceId,
    expected_stage_id: witness.stageId,
    expected_artifact_id: witness.artifactId,
    expected_version: witness.artifactVersion,
    p_expected_review_revision: witness.reviewRevision,
    approver_member_id: witness.memberId,
    p_agent_model_name: "gpt-5.5",
    p_agent_model_provider: "codex",
    p_run_type: "code",
  });
  assert(!approved.error, approved.error?.message);
  const receipt = await admin
    .from("session_stage_approval_receipts")
    .select("id")
    .match(review)
    .single();
  assert(!receipt.error && receipt.data, receipt.error?.message);
  for (let attempt = 0; attempt < 20; attempt++) {
    await drainAuthoredFactoryWorkflowEntry(admin);
    const observed = await readWorkflowHandoff(admin, witness);
    if (getWorkflowHandoffResult(observed, "human.review") === `human-gate:${receipt.data.id}`) {
      assert.equal(observed.results.length, 3);
      console.log(
        JSON.stringify({
          status: "passed",
          preparationRunId: witness.inputRunId,
          graphRevisionId: witness.graphRevisionId,
          recoveredOccurrenceId: abandoned.occurrenceId,
          exactApprovalId: receipt.data.id,
          staleLeaseRejected: true,
        }),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The exact human approval did not finish the authored workflow.");
}

if (process.env.WALLIE_M11_HANDOFF_PHASE) {
  const raw = process.env.WALLIE_FACTORY_RUNTIME_FIXTURE;
  const witnessPath = process.env.WALLIE_M11_WITNESS_PATH;
  const abandonedPath = process.env.WALLIE_M11_ABANDONED_PATH;
  assert(raw && witnessPath && abandonedPath);
  const witness = workflowHandoffWitness.parse(JSON.parse(readFileSync(witnessPath, "utf8")));
  const phase = process.env.WALLIE_M11_HANDOFF_PHASE;
  assert(phase === "abandon" || phase === "approve");
  const operation =
    phase === "abandon"
      ? abandon(raw, witness, abandonedPath)
      : verifyAndApprove(createFactoryRuntimeClients(raw).admin, witness, abandonedPath);
  operation.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Workflow handoff failed.");
    process.exitCode = 1;
  });
}
