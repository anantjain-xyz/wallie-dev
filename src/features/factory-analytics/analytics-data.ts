import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import type { AuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import type { Database } from "@/lib/supabase/database.types";

import {
  type AnalyticsEvidenceSelection,
  type AnalyticsQuery,
  type AnalyticsWindow,
  analyticsEnvironmentSchema,
  analyticsDeliveryStatusSchema,
  analyticsDimensionSchema,
  analyticsFlowPhaseSchema,
  analyticsRevertStatusSchema,
} from "./analytics-query";

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();
const value = z.number().nonnegative();
const windowSchema = z.object({ from: timestamp, to: timestamp });
const metricSchema = z.object({ metricKey: z.string(), metricRevision: count });
const rolesVisibilitySchema = z.enum(["full", "redacted"]);
const detailsPageSize = 25;

function phaseMap<T extends z.ZodTypeAny>(schema: T) {
  return z.object({
    queued: schema,
    active: schema,
    blocked: schema,
    review: schema,
    delivery: schema,
    unknown: schema,
  });
}

const distribution = z.object({
  total: count,
  measured: count,
  censored: count,
  unknown: count,
  distribution: z
    .object({ minSeconds: value, p50Seconds: value, p95Seconds: value, maxSeconds: value })
    .nullable(),
});
const flowSummary = z.object({
  window: windowSchema.extend({ deploymentEnvironment: z.string().nullable() }),
  metricRevisions: z.object({
    workflow_flow: count,
    request_to_merge: count,
    request_to_deployment: count,
  }),
  coverage: z.object({
    lifecycleFrom: timestamp.nullable(),
    pullRequestsFrom: timestamp.nullable(),
    deploymentsFrom: timestamp.nullable(),
    lifecycleWindowCovered: z.boolean(),
    deploymentProviderCompleteness: z.string(),
    openRequests: phaseMap(count),
    unplacedSessions: count,
  }),
  freshness: z.object({
    status: z.enum(["ready", "building", "paused", "failed", "unavailable"]),
    lastSuccessAt: timestamp.nullable(),
    sourceSnapshotAt: timestamp.nullable(),
    evaluatedAt: timestamp,
  }),
  flow: phaseMap(z.object({ seconds: value, segments: count, sessions: count })),
  merge: distribution,
  deployment: distribution,
});

const costMeasure = metricSchema.extend({
  category: z.literal("product_attempt"),
  costState: z.enum(["no_attempts", "unavailable", "partial", "estimated", "measured"]),
  knownCostUsd: value.nullable(),
  measuredAttempts: count,
  estimatedAttempts: count,
  unavailableAttempts: count,
  pendingAttempts: count,
  unresolvedAttributionAttempts: count,
  unlinkedAttempts: count,
  knownCostPerObservedMergeUsd: value.nullable(),
  ratioState: z.enum(["no_observed_merges", "unavailable", "partial", "estimated", "measured"]),
});
const costSummary = windowSchema.extend({
  workspaceId: id,
  factoryId: id,
  observedAt: timestamp,
  mergeCohort: z.object({
    observedMergeCount: count,
    unresolvedMergeCount: count,
    captureStartedAt: timestamp.nullable(),
    partialCoverage: z.boolean(),
  }),
  costs: z.object({ delivery: costMeasure, operating: costMeasure }),
  unavailableCostCategories: z.array(
    z.object({ category: z.string(), state: z.literal("unavailable"), reason: z.string() }),
  ),
});

const throughputSummary = metricSchema.extend({
  dimension: analyticsDimensionSchema,
  window: windowSchema,
  observedMergeCount: count,
  mixedMergeCount: count,
  partialMergeCount: count,
  bucketMembershipCount: count,
  bucketCount: count,
  bucketsTruncated: z.boolean(),
  omittedBucketMembershipCount: count,
  buckets: z.array(
    z.object({ key: z.string(), label: z.string(), mergeCount: count, runCount: count }),
  ),
  coverage: z.object({
    captureStartedAt: timestamp.nullable(),
    unresolvedMergeCount: count,
    partial: z.boolean(),
  }),
  evaluatedAt: timestamp,
});

const revertWindow = windowSchema.extend({ asOf: timestamp, observationWindowSeconds: count });
const revertSummary = metricSchema.extend({
  window: revertWindow,
  observedMergeCount: count,
  coveredMatureCount: count,
  revertedCoveredCount: count,
  verifiedRevertedCount: count,
  immatureCount: count,
  partialCount: count,
  ambiguousCount: count,
  revertRate: value.max(1).nullable(),
  coverage: z.object({
    captureStartedAt: timestamp.nullable(),
    revertEvidenceStartedAt: timestamp.nullable(),
    unresolvedOriginalCount: count,
    partial: z.boolean(),
  }),
});

type AnalyticsResult<T> = { status: "ready"; data: T } | { status: "unavailable" };
export type AnalyticsPeriodData = {
  window: AnalyticsWindow;
  flow: AnalyticsResult<z.infer<typeof flowSummary>>;
  cost: AnalyticsResult<z.infer<typeof costSummary>>;
  throughput: AnalyticsResult<z.infer<typeof throughputSummary>>;
  revert: AnalyticsResult<z.infer<typeof revertSummary>>;
};

type AnalyticsContext = Pick<AuthenticatedWorkspaceContext, "supabase"> & {
  workspaceId: string;
  factoryId: string;
  query: AnalyticsQuery;
};

function rpcScope(context: AnalyticsContext, window: AnalyticsWindow) {
  return {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_from: window.from,
    p_to: window.to,
  };
}

async function read<T>(
  request: () => PromiseLike<{ data: unknown; error: unknown }>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<AnalyticsResult<T>> {
  try {
    const { data, error } = await request();
    if (!error) {
      const parsed = schema.safeParse(data);
      if (parsed.success) return { status: "ready", data: parsed.data };
    }
  } catch {
    return { status: "unavailable" };
  }
  return { status: "unavailable" };
}

export async function loadDeploymentEnvironments({
  supabase,
  workspaceId,
  factoryId,
}: Omit<AnalyticsContext, "query">) {
  const result = await read(
    () =>
      supabase.rpc("list_factory_analytics_deployment_environments", {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
      }),
    z.array(analyticsEnvironmentSchema),
  );
  return result.status === "ready" ? result.data : null;
}

async function loadAnalyticsPeriod(
  context: AnalyticsContext,
  window: AnalyticsWindow,
): Promise<AnalyticsPeriodData> {
  const { supabase, query } = context;
  const scope = rpcScope(context, window);
  const [flow, cost, throughput, revert] = await Promise.all([
    read(
      () =>
        supabase.rpc("get_factory_flow_summary", {
          ...scope,
          p_environment: query.environment ?? undefined,
        }),
      flowSummary,
    ),
    read(() => supabase.rpc("get_factory_cost_summary", scope), costSummary),
    read(
      () =>
        supabase.rpc("get_factory_throughput_breakdown", {
          ...scope,
          p_dimension: query.dimension,
        }),
      throughputSummary,
    ),
    read(() => supabase.rpc("get_factory_revert_summary", scope), revertSummary),
  ]);
  return { window, flow, cost, throughput, revert };
}

export async function loadAnalyticsPeriods(context: AnalyticsContext) {
  const { from, to, comparison: compareWindow } = context.query;
  const [primary, comparison] = await Promise.all([
    loadAnalyticsPeriod(context, { from, to }),
    compareWindow ? loadAnalyticsPeriod(context, compareWindow) : null,
  ]);
  return { primary, comparison };
}

const flowObservation = z.object({
  id,
  eventType: z.string(),
  occurredAt: timestamp,
  observedAt: timestamp,
  jobId: id.nullable(),
  runId: id.nullable(),
  attemptCount: count.nullable(),
  artifactId: id.nullable(),
});
const flowEvidence = z.object({
  sessionId: id,
  phase: analyticsFlowPhaseSchema,
  status: z.enum(["measured", "unknown"]),
  startedAt: timestamp,
  endedAt: timestamp,
  sourceStartedAt: timestamp,
  sourceEndedAt: timestamp,
  seconds: value,
  observationIds: z.array(id),
  observations: z.array(flowObservation).optional(),
});
const deliveryEvidence = z.object({
  sessionId: id,
  requestedAt: timestamp,
  requestObservationId: id.nullable(),
  status: analyticsDeliveryStatusSchema,
  deliveredAt: timestamp.nullable(),
  seconds: value.nullable(),
  canonicalMergeId: id.nullable(),
  mergeObservationId: id.nullable(),
  deploymentId: id.nullable(),
  deploymentObservationId: id.nullable(),
  deploymentEnvironment: z.string().nullable(),
});
const costEvidence = z
  .object({
    run_id: id,
    session_id: id,
    attempt_count: count,
    run_status: z.string(),
    started_at: timestamp,
    finished_at: timestamp.nullable(),
    merge_id: id.nullable(),
    merge_observation_id: id.nullable(),
    candidate_merge_id: id.nullable(),
    attribution: z.enum([
      "exact_publication_receipt",
      "settled_session_window",
      "unresolved",
      "unlinked",
    ]),
    cost_state: z.enum(["measured", "estimated", "unavailable", "pending"]),
    cost_usd: value.nullable(),
    usage_recorded_at: timestamp.nullable(),
    usage_finalized_at: timestamp.nullable(),
    usage_estimation_revision: z.string().nullable(),
  })
  .transform((row) => ({
    runId: row.run_id,
    sessionId: row.session_id,
    attemptCount: row.attempt_count,
    runStatus: row.run_status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    mergeId: row.merge_id,
    mergeObservationId: row.merge_observation_id,
    candidateMergeId: row.candidate_merge_id,
    attribution: row.attribution,
    costState: row.cost_state,
    costUsd: row.cost_usd,
    usageRecordedAt: row.usage_recorded_at,
    usageFinalizedAt: row.usage_finalized_at,
    usageEstimationRevision: row.usage_estimation_revision,
  }));
const costMergeEvidence = z.object({
  mergeId: id,
  mergeObservationId: id,
  sessionId: id,
  repositoryId: id,
  pullRequestNumber: count,
  mergedAt: timestamp,
  mergeCommitSha: z.string(),
});
const throughputEvidence = z.object({
  bucketKey: z.string(),
  bucketLabel: z.string(),
  rawBucketKey: z.string(),
  rawBucketLabel: z.string(),
  dimensionKeys: z.record(analyticsDimensionSchema, z.string()),
  dimensionLabels: z.record(analyticsDimensionSchema, z.string()),
  mergeId: id,
  mergeObservationId: id,
  mergedAt: timestamp,
  sessionId: id,
  repositoryId: id,
  pullRequestNumber: count,
  runId: id.nullable(),
  attemptCount: count.nullable(),
  requestSource: z.string().nullable(),
  requestSourceReceiptId: id.nullable(),
  invokingActorMemberId: id.nullable(),
  invokingActorServicePrincipalId: id.nullable(),
  credentialOwnerMemberId: id.nullable(),
  credentialOwnerServicePrincipalId: id.nullable(),
  budgetPayerMemberId: id.nullable(),
  agentId: id.nullable(),
  agentPromptRevisionId: id.nullable(),
  modelName: z.string().nullable(),
  harness: z.string().nullable(),
  workerRuntime: z.string().nullable(),
  definitionRevisionId: id.nullable(),
  definitionDigest: z.string().nullable(),
});
const revertEvidence = z.object({
  originalMergeId: id,
  originalObservationId: id,
  originalMergeSha: z.string(),
  originalMergedAt: timestamp,
  sessionId: id,
  repositoryId: id,
  baseBranch: z.string(),
  pullRequestNumber: count,
  windowEndsAt: timestamp,
  status: analyticsRevertStatusSchema,
  hasCompleteCoverage: z.boolean(),
  hasVerifiedRevert: z.boolean(),
  verifiedRelationshipCount: count,
  unresolvedRelationshipCount: count,
  relationshipsTruncated: z.boolean(),
  coverageIds: z.array(id),
  coverageCount: count,
  relationships: z.array(
    z.object({
      observationId: id,
      revision: count,
      current: z.boolean(),
      status: z.enum(["candidate", "confirmed", "invalidated"]),
      evidenceState: z.string(),
      stale: z.boolean(),
      originalObservationId: id,
      originalMergeSha: z.string(),
      originalMergedAt: timestamp,
      revertPrNumber: count,
      revertMergeSha: z.string().nullable(),
      revertMergedAt: timestamp.nullable(),
      providerUpdatedAt: timestamp.nullable(),
      observedAt: timestamp,
      actorMemberId: id.nullable(),
      withinWindow: z.boolean().nullable(),
    }),
  ),
});

const flowCursor = z.object({ at: timestamp, sessionId: id, endAt: timestamp });
const mergeCursor = z.object({ at: timestamp, mergeId: id });
const costCursor = z.object({ runId: id });
const throughputCursor = mergeCursor
  .extend({
    runId: id.nullable(),
    attemptCount: z.number().int().positive().nullable(),
  })
  .refine(({ runId, attemptCount }) => (runId === null) === (attemptCount === null));

const flowPage = z.object({
  metricRevision: count,
  items: z.array(flowEvidence),
  nextCursor: flowCursor.nullable(),
});
const deliveryPage = z.object({
  metricRevision: count,
  items: z.array(deliveryEvidence),
  nextCursor: flowCursor.nullable(),
});
const costMergePage = z.object({
  items: z.array(costMergeEvidence),
  nextCursor: mergeCursor.nullable(),
});
const throughputPage = metricSchema.extend({
  dimension: analyticsDimensionSchema,
  rolesVisibility: rolesVisibilitySchema,
  items: z.array(throughputEvidence),
  nextCursor: throughputCursor.nullable(),
});
const revertPage = metricSchema.extend({
  window: revertWindow,
  items: z.array(revertEvidence),
  nextCursor: mergeCursor.nullable(),
});

type EvidencePage<Metric extends AnalyticsEvidenceSelection["metric"], Item> = {
  metric: Metric;
  items: Item[];
  nextCursor: string | null;
  sessionNumbers: Record<string, number>;
};
export type AnalyticsEvidence =
  | (EvidencePage<"flow", z.infer<typeof flowEvidence>> & { metricRevision: number })
  | (EvidencePage<"merge" | "deployment", z.infer<typeof deliveryEvidence>> & {
      metricRevision: number;
    })
  | EvidencePage<"delivery-cost" | "operating-cost", z.infer<typeof costEvidence>>
  | EvidencePage<"cost-merges", z.infer<typeof costMergeEvidence>>
  | (EvidencePage<"throughput", z.infer<typeof throughputEvidence>> & {
      metricRevision: number;
      rolesVisibility: z.infer<typeof rolesVisibilitySchema>;
    })
  | (EvidencePage<"revert", z.infer<typeof revertEvidence>> & {
      metricRevision: number;
      window: z.infer<typeof revertWindow>;
    });

function cursorScope(
  context: AnalyticsContext,
  window: AnalyticsWindow,
  selection: AnalyticsEvidenceSelection,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.workspaceId,
        context.factoryId,
        window.from,
        window.to,
        selection.metric,
        selection.period,
        context.query.dimension,
        context.query.environment,
        "facet" in selection ? selection.facet : null,
        "bucket" in selection ? selection.bucket : null,
      ]),
    )
    .digest("base64url");
}

function parseCursor<T>(
  encoded: string | undefined,
  scope: string,
  schema: z.ZodType<T>,
): T | null | undefined {
  if (!encoded) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const envelope = z.object({ scope: z.literal(scope), position: schema }).safeParse(decoded);
    if (envelope.success) return envelope.data.position;
  } catch {
    return undefined;
  }
  return undefined;
}

async function evidencePage<
  Metric extends AnalyticsEvidenceSelection["metric"],
  Item extends { sessionId: string },
  Cursor,
>(
  context: AnalyticsContext,
  metric: Metric,
  scope: string,
  items: Item[],
  cursor: Cursor | null,
): Promise<EvidencePage<Metric, Item>> {
  const sessionIds = [...new Set(items.map((item) => item.sessionId))];
  const sessionNumbers: Record<string, number> = {};
  if (sessionIds.length > 0) {
    const { data } = await context.supabase
      .from("sessions")
      .select("id, number")
      .eq("workspace_id", context.workspaceId)
      .eq("factory_id", context.factoryId)
      .in("id", sessionIds);
    for (const session of data ?? []) sessionNumbers[session.id] = session.number;
  }
  return {
    metric,
    items,
    sessionNumbers,
    nextCursor:
      cursor === null
        ? null
        : Buffer.from(JSON.stringify({ scope, position: cursor })).toString("base64url"),
  };
}

type AnalyticsFunctions = Database["public"]["Functions"];

export async function loadAnalyticsEvidence(
  context: AnalyticsContext,
): Promise<AnalyticsResult<AnalyticsEvidence> | null> {
  const { query, supabase } = context;
  const selection = query.evidence;
  if (!selection) return null;
  const window = selection.period === "compare" ? query.comparison : query;
  if (!window) return { status: "unavailable" };
  const scope = rpcScope(context, window);
  const cursorKey = cursorScope(context, window, selection);
  switch (selection.metric) {
    case "flow":
    case "merge":
    case "deployment": {
      const cursor = parseCursor(selection.cursor, cursorKey, flowCursor);
      if (cursor === undefined) return { status: "unavailable" };
      const metricKeys = {
        flow: "workflow_flow",
        merge: "request_to_merge",
        deployment: "request_to_deployment",
      };
      const args: AnalyticsFunctions["list_factory_flow_evidence"]["Args"] = {
        ...scope,
        p_metric_key: metricKeys[selection.metric],
        p_limit: detailsPageSize,
        p_environment: query.environment ?? undefined,
        p_facet: selection.facet,
        p_cursor_at: cursor?.at,
        p_cursor_session_id: cursor?.sessionId,
        p_cursor_end_at: cursor?.endAt,
      };
      if (selection.metric === "flow") {
        const result = await read(() => supabase.rpc("list_factory_flow_evidence", args), flowPage);
        if (result.status !== "ready") return result;
        const { items, nextCursor, metricRevision } = result.data;
        const page = await evidencePage(context, selection.metric, cursorKey, items, nextCursor);
        return { status: "ready", data: { ...page, metricRevision } };
      }
      const result = await read(
        () => supabase.rpc("list_factory_flow_evidence", args),
        deliveryPage,
      );
      if (result.status !== "ready") return result;
      const { items, nextCursor, metricRevision } = result.data;
      const page = await evidencePage(context, selection.metric, cursorKey, items, nextCursor);
      return { status: "ready", data: { ...page, metricRevision } };
    }
    case "delivery-cost":
    case "operating-cost": {
      const cursor = parseCursor(selection.cursor, cursorKey, costCursor);
      if (cursor === undefined) return { status: "unavailable" };
      const args: AnalyticsFunctions["list_factory_cost_contributions"]["Args"] = {
        ...scope,
        p_basis: selection.metric === "delivery-cost" ? "delivery" : "operating",
        p_facet: selection.facet,
        p_after_run_id: cursor?.runId,
        p_limit: detailsPageSize + 1,
      };
      const result = await read(
        () => supabase.rpc("list_factory_cost_contributions", args),
        z.array(costEvidence),
      );
      if (result.status !== "ready") return result;
      const items = result.data.slice(0, detailsPageSize);
      const last = result.data.length > detailsPageSize ? items.at(-1) : undefined;
      const page = await evidencePage(
        context,
        selection.metric,
        cursorKey,
        items,
        last ? { runId: last.runId } : null,
      );
      return { status: "ready", data: page };
    }
    case "cost-merges": {
      const cursor = parseCursor(selection.cursor, cursorKey, mergeCursor);
      if (cursor === undefined) return { status: "unavailable" };
      const result = await read(
        () =>
          supabase.rpc("list_factory_cost_merges", {
            ...scope,
            p_limit: detailsPageSize,
            p_cursor_at: cursor?.at,
            p_cursor_merge_id: cursor?.mergeId,
          }),
        costMergePage,
      );
      if (result.status !== "ready") return result;
      const { items, nextCursor } = result.data;
      return {
        status: "ready",
        data: await evidencePage(context, selection.metric, cursorKey, items, nextCursor),
      };
    }
    case "throughput": {
      const cursor = parseCursor(selection.cursor, cursorKey, throughputCursor);
      if (cursor === undefined) return { status: "unavailable" };
      const result = await read(
        () =>
          supabase.rpc("list_factory_throughput_contributions", {
            ...scope,
            p_dimension: query.dimension,
            p_bucket_key: selection.bucket,
            p_limit: detailsPageSize,
            p_cursor_at: cursor?.at,
            p_cursor_merge_id: cursor?.mergeId,
            p_cursor_run_id: cursor?.runId ?? undefined,
            p_cursor_attempt_count: cursor?.attemptCount ?? undefined,
          }),
        throughputPage,
      );
      if (result.status !== "ready") return result;
      const { items, nextCursor, metricRevision, rolesVisibility } = result.data;
      const page = await evidencePage(context, selection.metric, cursorKey, items, nextCursor);
      return { status: "ready", data: { ...page, metricRevision, rolesVisibility } };
    }
    case "revert": {
      const cursor = parseCursor(selection.cursor, cursorKey, mergeCursor);
      if (cursor === undefined) return { status: "unavailable" };
      const verified = selection.facet === "verified" || selection.facet === "covered-verified";
      const status =
        selection.facet === "covered-verified" ? "covered" : verified ? undefined : selection.facet;
      const args: AnalyticsFunctions["list_factory_revert_evidence"]["Args"] = {
        ...scope,
        p_status: status,
        p_has_verified_revert: verified || undefined,
        p_limit: detailsPageSize,
        p_cursor_at: cursor?.at,
        p_cursor_merge_id: cursor?.mergeId,
      };
      const result = await read(
        () => supabase.rpc("list_factory_revert_evidence", args),
        revertPage,
      );
      if (result.status !== "ready") return result;
      const { items, nextCursor, metricRevision, window } = result.data;
      const page = await evidencePage(context, selection.metric, cursorKey, items, nextCursor);
      return { status: "ready", data: { ...page, metricRevision, window } };
    }
  }
}
