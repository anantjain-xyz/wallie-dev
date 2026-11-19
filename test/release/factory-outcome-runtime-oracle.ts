import assert from "node:assert/strict";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import type { Database } from "@/lib/supabase/database.types";
import { projectionHealthSchema } from "@/features/factory-overview/projection-health-contracts";

const scopeSchema = z.object({
  workspaceId: z.uuid(),
  factoryId: z.uuid(),
  siblingFactoryId: z.uuid(),
  otherWorkspaceId: z.uuid(),
  otherFactoryId: z.uuid(),
  deliveredSessionId: z.uuid(),
  failedRunId: z.uuid(),
  producingRunId: z.uuid(),
  requestObservationId: z.uuid(),
  mergeId: z.uuid(),
  from: z.iso.date(),
  to: z.iso.date(),
  comparisonFrom: z.iso.date(),
});
const receiptsSchema = z.object({
  mergeObservationId: z.uuid(),
  deploymentObservationId: z.uuid(),
});
const oracleSchema = z.object({
  observedMergeCount: z.number(),
  previousObservedMergeCount: z.number(),
  mergeMeasured: z.number(),
  mergeUnknown: z.number(),
  deploymentMeasured: z.number(),
  phaseSeconds: z.object({
    queued: z.number(),
    active: z.number(),
    blocked: z.number(),
    review: z.number(),
    delivery: z.number(),
    unknown: z.number(),
  }),
  correctedDeliveryPhaseSeconds: z.number(),
  mergeMedianSeconds: z.number(),
  correctedMergeMedianSeconds: z.number(),
  deploymentMedianSeconds: z.number(),
  correctedDeploymentMedianSeconds: z.number(),
  knownCostUsd: z.number(),
  costPerObservedMergeUsd: z.number(),
  matureCoveredCount: z.number(),
  revertedCoveredCount: z.number(),
  ambiguousRevertCount: z.number(),
  immatureRevertCount: z.number(),
  revertRate: z.number(),
});

export const outcomeRuntimeNativeConfig = z.object({
  url: z.url(),
  publishableKey: z.string().min(1),
  ownerToken: z.string().min(1),
  viewerToken: z.string().min(1),
  scope: scopeSchema,
  receipts: receiptsSchema,
  expected: oracleSchema,
});

type Scope = z.infer<typeof scopeSchema>;
type NativeConfig = z.infer<typeof outcomeRuntimeNativeConfig>;
type Client = SupabaseClient<Database>;

const medians = z.object({
  distribution: z.object({ p50Seconds: z.number() }),
  measured: z.number(),
  unknown: z.number(),
});
const phase = z.object({ seconds: z.number() });
const flowSummary = z.object({
  freshness: z.object({ status: z.literal("ready") }),
  flow: z.object({
    queued: phase,
    active: phase,
    blocked: phase,
    review: phase,
    delivery: phase,
    unknown: phase,
  }),
  merge: medians,
  deployment: medians,
});
const resultRows = z.object({
  items: z.array(
    z.object({
      sessionId: z.uuid(),
      requestObservationId: z.uuid().nullish(),
      canonicalMergeId: z.uuid().nullish(),
      mergeObservationId: z.uuid().nullish(),
      deploymentObservationId: z.uuid().nullish(),
      observations: z.array(z.object({ runId: z.uuid().nullable() })).optional(),
    }),
  ),
});
const costSummary = z.object({
  mergeCohort: z.object({ observedMergeCount: z.number() }),
  costs: z.object({
    delivery: z.object({
      knownCostUsd: z.number(),
      knownCostPerObservedMergeUsd: z.number(),
      unavailableAttempts: z.number().positive(),
    }),
  }),
});
const throughputSummary = z.object({ observedMergeCount: z.number() });
const revertSummary = z.object({
  coveredMatureCount: z.number(),
  revertedCoveredCount: z.number(),
  ambiguousCount: z.number(),
  immatureCount: z.number(),
  revertRate: z.number(),
});

export function localOutcomeClient(url: string, publishableKey: string, token?: string) {
  const endpoint = new URL(url);
  assert.equal(endpoint.protocol, "http:");
  assert(["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname));
  return createClient<Database>(endpoint.origin, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(token ? { accessToken: async () => token } : {}),
  });
}

function scopedRead(scope: Scope, factoryId = scope.factoryId) {
  return { p_workspace_id: scope.workspaceId, p_factory_id: factoryId };
}

export function rpcValue<T>({ data, error }: { data: T | null; error: { code: string } | null }) {
  assert(!error, "The scoped database request failed: " + (error?.code ?? "unknown"));
  assert(data !== null, "The scoped database request returned no evidence.");
  return data;
}

export async function readOutcomeHealth(client: Client, scope: Scope, factoryId = scope.factoryId) {
  return projectionHealthSchema.parse(
    rpcValue(await client.rpc("get_factory_flow_projection_health", scopedRead(scope, factoryId))),
  );
}

export async function controlOutcomeProjection(
  client: Client,
  scope: Scope,
  action: "pause" | "resume" | "rebuild",
  factoryId = scope.factoryId,
) {
  return projectionHealthSchema.parse(
    rpcValue(
      await client.rpc("control_factory_flow_projection", {
        ...scopedRead(scope, factoryId),
        p_action: action,
      }),
    ),
  );
}

export async function readAuthoritativeOutcome(client: Client, scope: Scope) {
  const [session, runs] = await Promise.all([
    client
      .from("sessions")
      .select("*")
      .eq("workspace_id", scope.workspaceId)
      .eq("factory_id", scope.factoryId)
      .eq("id", scope.deliveredSessionId)
      .single(),
    client
      .from("agent_runs")
      .select("*")
      .eq("workspace_id", scope.workspaceId)
      .eq("session_id", scope.deliveredSessionId)
      .in("id", [scope.failedRunId, scope.producingRunId])
      .order("id"),
  ]);
  const authority = { session: rpcValue(session), runs: rpcValue(runs) };
  assert.equal(authority.runs.length, 2);
  return authority;
}

export async function assertOutcomeTenantScope(owner: Client, viewer: Client, scope: Scope) {
  const [forbiddenHealth, forbiddenTenant, forbiddenPause, ownerRoles, viewerRoles] =
    await Promise.all([
      viewer.rpc("get_factory_flow_projection_health", scopedRead(scope, scope.siblingFactoryId)),
      viewer.rpc("get_factory_flow_projection_health", {
        p_workspace_id: scope.otherWorkspaceId,
        p_factory_id: scope.otherFactoryId,
      }),
      viewer.rpc("control_factory_flow_projection", { ...scopedRead(scope), p_action: "pause" }),
      owner.rpc("list_factory_throughput_contributions", {
        ...scopedRead(scope),
        p_from: scope.from,
        p_to: scope.to,
        p_limit: 1,
      }),
      viewer.rpc("list_factory_throughput_contributions", {
        ...scopedRead(scope),
        p_from: scope.from,
        p_to: scope.to,
        p_limit: 1,
      }),
    ]);
  assert.equal(forbiddenHealth.error?.code, "PT404");
  assert.equal(forbiddenTenant.error?.code, "PT404");
  assert.equal(forbiddenPause.error?.code, "PT404");
  const roles = z.object({ rolesVisibility: z.enum(["full", "redacted"]) });
  assert.equal(roles.parse(rpcValue(ownerRoles)).rolesVisibility, "full");
  assert.equal(roles.parse(rpcValue(viewerRoles)).rolesVisibility, "redacted");
}

export async function assertOutcomeRuntimeOracle(
  viewer: Client,
  { scope, receipts, expected }: Pick<NativeConfig, "scope" | "receipts" | "expected">,
  state: "baseline" | "corrected",
) {
  const window = { ...scopedRead(scope), p_from: scope.from, p_to: scope.to };
  const deliveryWindow = { ...window, p_environment: "production" };
  const [flow, active, merge, deployment, cost, throughput, previous, revert] = await Promise.all([
    viewer.rpc("get_factory_flow_summary", deliveryWindow),
    viewer.rpc("list_factory_flow_evidence", {
      ...window,
      p_metric_key: "workflow_flow",
      p_facet: "active",
      p_limit: 100,
    }),
    viewer.rpc("list_factory_flow_evidence", {
      ...deliveryWindow,
      p_metric_key: "request_to_merge",
      p_facet: "measured",
    }),
    viewer.rpc("list_factory_flow_evidence", {
      ...deliveryWindow,
      p_metric_key: "request_to_deployment",
      p_facet: "measured",
    }),
    viewer.rpc("get_factory_cost_summary", window),
    viewer.rpc("get_factory_throughput_breakdown", { ...window, p_dimension: "source" }),
    viewer.rpc("get_factory_throughput_breakdown", {
      ...window,
      p_from: scope.comparisonFrom,
      p_to: scope.from,
      p_dimension: "source",
    }),
    viewer.rpc("get_factory_revert_summary", window),
  ]);
  const flowValues = flowSummary.parse(rpcValue(flow));
  assert.deepEqual(
    Object.fromEntries(Object.entries(flowValues.flow).map(([name, data]) => [name, data.seconds])),
    {
      ...expected.phaseSeconds,
      delivery:
        state === "corrected"
          ? expected.correctedDeliveryPhaseSeconds
          : expected.phaseSeconds.delivery,
    },
  );
  assert.equal(flowValues.merge.measured, expected.mergeMeasured);
  assert.equal(flowValues.merge.unknown, expected.mergeUnknown);
  assert.equal(flowValues.deployment.measured, expected.deploymentMeasured);
  assert.equal(
    flowValues.merge.distribution.p50Seconds,
    state === "corrected" ? expected.correctedMergeMedianSeconds : expected.mergeMedianSeconds,
  );
  assert.equal(
    flowValues.deployment.distribution.p50Seconds,
    state === "corrected"
      ? expected.correctedDeploymentMedianSeconds
      : expected.deploymentMedianSeconds,
  );

  const activeProofs = resultRows
    .parse(rpcValue(active))
    .items.filter((row) => row.sessionId === scope.deliveredSessionId)
    .flatMap((row) => row.observations ?? [])
    .map((observation) => observation.runId);
  assert(
    activeProofs.includes(scope.producingRunId),
    "The active interval lost its producing run receipt.",
  );
  assert(
    activeProofs.includes(scope.failedRunId),
    "The retry cost cohort lost its failed run receipt.",
  );

  const mergeProof = resultRows
    .parse(rpcValue(merge))
    .items.find((row) => row.sessionId === scope.deliveredSessionId);
  const deploymentProof = resultRows
    .parse(rpcValue(deployment))
    .items.find((row) => row.sessionId === scope.deliveredSessionId);
  assert(mergeProof);
  assert(deploymentProof);
  assert.equal(mergeProof.requestObservationId, scope.requestObservationId);
  assert.equal(mergeProof.canonicalMergeId, scope.mergeId);
  assert.equal(mergeProof.mergeObservationId, receipts.mergeObservationId);
  assert.equal(deploymentProof.requestObservationId, scope.requestObservationId);
  assert.equal(deploymentProof.mergeObservationId, receipts.mergeObservationId);
  assert.equal(deploymentProof.deploymentObservationId, receipts.deploymentObservationId);

  const costs = costSummary.parse(rpcValue(cost));
  assert.equal(costs.mergeCohort.observedMergeCount, expected.observedMergeCount);
  assert.equal(costs.costs.delivery.knownCostUsd, expected.knownCostUsd);
  assert.equal(costs.costs.delivery.knownCostPerObservedMergeUsd, expected.costPerObservedMergeUsd);
  assert.equal(
    throughputSummary.parse(rpcValue(throughput)).observedMergeCount,
    expected.observedMergeCount,
  );
  assert.equal(
    throughputSummary.parse(rpcValue(previous)).observedMergeCount,
    expected.previousObservedMergeCount,
  );
  assert.deepEqual(revertSummary.parse(rpcValue(revert)), {
    coveredMatureCount: expected.matureCoveredCount,
    revertedCoveredCount: expected.revertedCoveredCount,
    ambiguousCount: expected.ambiguousRevertCount,
    immatureCount: expected.immatureRevertCount,
    revertRate: expected.revertRate,
  });
}
