import assert from "node:assert/strict";

import { z } from "zod";

const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();
const id = z.string().uuid();
const phase = z.enum(["queued", "active", "blocked", "review", "delivery", "unknown"]);
const deliveryStatus = z.enum(["measured", "censored", "unknown"]);
const revertStatus = z.enum(["covered", "immature", "partial", "ambiguous"]);

const phaseSummary = z.object({ seconds: amount, segments: count, sessions: count });
const durationSummary = z.object({
  total: count,
  measured: count,
  censored: count,
  unknown: count,
  distribution: z
    .object({ minSeconds: amount, p50Seconds: amount, p95Seconds: amount, maxSeconds: amount })
    .nullable(),
});
const attemptSummary = z.object({
  knownCostUsd: amount.nullable(),
  knownCostPerObservedMergeUsd: amount.nullable(),
  measuredAttempts: count,
  estimatedAttempts: count,
  unavailableAttempts: count,
  pendingAttempts: count,
  unresolvedAttributionAttempts: count,
  unlinkedAttempts: count,
});
const attributionBucket = z.object({ key: z.string(), mergeCount: count, runCount: count });
const throughputSummary = z.object({
  observedMergeCount: count,
  mixedMergeCount: count,
  partialMergeCount: count,
  bucketCount: count,
  bucketMembershipCount: count,
  bucketsTruncated: z.boolean(),
  omittedBucketMembershipCount: count,
  buckets: z.array(attributionBucket),
});
const revertSummary = z.object({
  observedMergeCount: count,
  coveredMatureCount: count,
  revertedCoveredCount: count,
  verifiedRevertedCount: count,
  immatureCount: count,
  partialCount: count,
  ambiguousCount: count,
  revertRate: amount.nullable(),
});

const flowRow = z.object({
  sessionId: id,
  phase,
  seconds: amount,
  startedAt: z.string(),
  endedAt: z.string(),
  observationIds: z.array(id).min(1),
});
const durationRow = z.object({
  sessionId: id,
  status: deliveryStatus,
  requestedAt: z.string(),
  deliveredAt: z.string().nullable(),
  seconds: amount.nullable(),
});
const attemptRow = z.object({
  run_id: id,
  merge_id: id.nullable(),
  attribution: z.string(),
  cost_state: z.enum(["measured", "estimated", "pending", "unavailable"]),
  cost_usd: amount.nullable(),
});
const throughputRow = z.object({
  mergeId: id,
  runId: id.nullable(),
  attemptCount: count.nullable(),
  rawBucketKey: z.string(),
  bucketKey: z.string(),
});
const revertRow = z.object({
  originalMergeId: id,
  status: revertStatus,
  hasVerifiedRevert: z.boolean(),
  verifiedRelationshipCount: count,
  coverageCount: count,
  coverageIds: z.array(id),
  relationships: z.array(z.object({ current: z.boolean(), withinWindow: z.boolean().nullable() })),
});

const exportSchema = z.object({
  schemaVersion: z.literal(1),
  periods: z
    .array(
      z.object({
        key: z.enum(["primary", "comparison"]),
        summaries: z.object({
          flow: z.object({
            flow: z.record(phase, phaseSummary),
            merge: durationSummary,
            deployment: durationSummary,
          }),
          cost: z.object({
            mergeCohort: z.object({ observedMergeCount: count }),
            costs: z.object({ delivery: attemptSummary, operating: attemptSummary }),
          }),
          throughput: throughputSummary,
          revert: revertSummary,
        }),
        evidence: z.object({
          flow: z.array(flowRow),
          merge: z.array(durationRow),
          deployment: z.array(durationRow),
          deliveryCost: z.array(attemptRow),
          operatingCost: z.array(attemptRow),
          costMerges: z.array(z.object({ mergeId: id, mergeObservationId: id })),
          throughput: z.array(throughputRow),
          revert: z.array(revertRow),
        }),
      }),
    )
    .min(1),
});

function closeInValue(actual: number | null, expected: number | null, field: string) {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, field);
    return;
  }
  assert.ok(
    Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-10,
    `${field}: expected ${expected}, received ${actual}`,
  );
}

function percentile(sorted: number[], fraction: number) {
  const index = fraction * (sorted.length - 1);
  const first = sorted[Math.floor(index)];
  const last = sorted[Math.ceil(index)];
  assert(first !== undefined && last !== undefined);
  return first + (last - first) * (index - Math.floor(index));
}

function epochMicroseconds(value: string) {
  const milliseconds = Date.parse(value);
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  const microseconds = milliseconds * 1_000 + Number(fraction.padEnd(6, "0").slice(3, 6));
  assert(Number.isSafeInteger(microseconds), "Expected an exact, finite evidence timestamp.");
  return microseconds;
}

function reconcileDuration(
  summary: z.infer<typeof durationSummary>,
  rows: z.infer<typeof durationRow>[],
  label: string,
) {
  assert.equal(
    new Set(rows.map(({ sessionId }) => sessionId)).size,
    rows.length,
    `${label} distinct requests`,
  );
  const seconds = rows
    .flatMap((row) => {
      if (row.status !== "measured") {
        assert.equal(row.seconds, null, `${label} unmeasured duration`);
        assert.equal(row.deliveredAt, null, `${label} unmeasured endpoint`);
        return [];
      }
      assert(row.seconds !== null && row.deliveredAt !== null, `${label} measured duration`);
      const elapsed =
        (epochMicroseconds(row.deliveredAt) - epochMicroseconds(row.requestedAt)) / 1_000_000;
      closeInValue(row.seconds, elapsed, `${label} exact request and delivery timestamps`);
      return [elapsed];
    })
    .sort((a, b) => a - b);
  assert.equal(summary.total, rows.length, `${label} request count`);
  for (const state of deliveryStatus.options) {
    assert.equal(
      summary[state],
      rows.filter(({ status }) => status === state).length,
      `${label} ${state}`,
    );
  }
  if (seconds.length === 0) {
    assert.equal(summary.distribution, null, `${label} missing distribution`);
    return;
  }
  assert(summary.distribution, `${label} has a measured distribution`);
  closeInValue(summary.distribution.minSeconds, percentile(seconds, 0), `${label} minimum`);
  closeInValue(summary.distribution.p50Seconds, percentile(seconds, 0.5), `${label} median`);
  closeInValue(summary.distribution.p95Seconds, percentile(seconds, 0.95), `${label} p95`);
  closeInValue(summary.distribution.maxSeconds, percentile(seconds, 1), `${label} maximum`);
}

function reconcileCost(
  summary: z.infer<typeof attemptSummary>,
  rows: z.infer<typeof attemptRow>[],
  basis: "delivery" | "operating",
  merges: number,
  label: string,
) {
  assert.equal(
    new Set(rows.map(({ run_id }) => run_id)).size,
    rows.length,
    `${label} distinct cost attempts`,
  );
  const included = basis === "delivery" ? rows.filter(({ merge_id }) => merge_id !== null) : rows;
  const totals = included.flatMap((fact) => {
    if (fact.cost_state === "measured" || fact.cost_state === "estimated") {
      assert(fact.cost_usd !== null, `${label} known attempt amount`);
      return [fact.cost_usd];
    }
    assert.equal(fact.cost_usd, null, `${label} missing attempt amount`);
    return [];
  });
  const cost = totals.length > 0 ? totals.reduce((sum, value) => sum + value, 0) : null;
  closeInValue(summary.knownCostUsd, cost, `${label} known cost`);
  closeInValue(
    summary.knownCostPerObservedMergeUsd,
    cost !== null && merges > 0 ? cost / merges : null,
    `${label} cost ratio`,
  );
  const states = {
    measured: "measuredAttempts",
    estimated: "estimatedAttempts",
    unavailable: "unavailableAttempts",
  } as const;
  for (const [state, key] of Object.entries(states)) {
    assert.equal(
      summary[key],
      included.filter(({ cost_state }) => cost_state === state).length,
      `${label} ${state}`,
    );
  }
  assert.equal(
    summary.pendingAttempts,
    rows.filter(({ cost_state }) => cost_state === "pending").length,
    `${label} pending`,
  );
  assert.equal(
    summary.unresolvedAttributionAttempts,
    rows.filter(({ attribution }) => attribution === "unresolved").length,
    `${label} unresolved`,
  );
  assert.equal(
    summary.unlinkedAttempts,
    rows.filter(({ attribution }) => attribution === "unlinked").length,
    `${label} unlinked`,
  );
}

function reconcileThroughput(
  summary: z.infer<typeof throughputSummary>,
  rows: z.infer<typeof throughputRow>[],
  label: string,
) {
  const merged = Map.groupBy(rows, ({ mergeId }) => mergeId);
  const buckets = Map.groupBy(rows, ({ bucketKey }) => bucketKey);
  assert.equal(summary.observedMergeCount, merged.size, `${label} canonical merges`);
  assert.equal(summary.bucketMembershipCount, merged.size, `${label} distinct memberships`);
  assert.equal(summary.bucketCount, buckets.size, `${label} dimension bucket count`);
  assert.equal(summary.bucketsTruncated, false, `${label} complete bounded bucket collection`);
  assert.equal(summary.omittedBucketMembershipCount, 0, `${label} omitted buckets`);
  assert.equal(summary.buckets.length, buckets.size, `${label} visible bucket count`);
  for (const [mergeId, facts] of merged) {
    const sourceKeys = new Set(facts.map(({ rawBucketKey }) => rawBucketKey));
    const knownKeys = [...sourceKeys].filter((key) => key !== "unknown" && key !== "unlinked");
    const bucket =
      knownKeys.length > 0 && knownKeys.length < sourceKeys.size
        ? "partial"
        : knownKeys.length > 1
          ? "mixed"
          : (knownKeys[0] ?? (sourceKeys.has("unknown") ? "unknown" : "unlinked"));
    assert(
      facts.every(({ bucketKey }) => bucketKey === bucket),
      `${label} merge ${mergeId} has one independently classified bucket`,
    );
    assert.equal(
      new Set(facts.map(({ runId, attemptCount }) => JSON.stringify([runId, attemptCount]))).size,
      facts.length,
      `${label} merge ${mergeId} contributor uniqueness`,
    );
  }
  for (const bucket of summary.buckets) {
    const contributors = buckets.get(bucket.key);
    assert(contributors, `${label} bucket ${bucket.key} has evidence`);
    assert.equal(
      bucket.mergeCount,
      new Set(contributors.map(({ mergeId }) => mergeId)).size,
      `${label} bucket ${bucket.key} unique merges`,
    );
    assert.equal(
      bucket.runCount,
      new Set(contributors.flatMap(({ runId }) => (runId ? [runId] : []))).size,
      `${label} bucket ${bucket.key} unique runs`,
    );
  }
  assert.equal(
    summary.mixedMergeCount,
    summary.buckets.find(({ key }) => key === "mixed")?.mergeCount ?? 0,
    `${label} mixed count`,
  );
  assert.equal(
    summary.partialMergeCount,
    summary.buckets.find(({ key }) => key === "partial")?.mergeCount ?? 0,
    `${label} partial count`,
  );
}

function reconcileReverts(
  summary: z.infer<typeof revertSummary>,
  rows: z.infer<typeof revertRow>[],
  label: string,
) {
  const covered = rows.filter(({ status }) => status === "covered");
  const numerator = covered.filter(({ hasVerifiedRevert }) => hasVerifiedRevert).length;
  assert.equal(
    new Set(rows.map(({ originalMergeId }) => originalMergeId)).size,
    rows.length,
    `${label} distinct original merges`,
  );
  for (const original of rows) {
    assert.equal(
      original.coverageCount,
      original.coverageIds.length,
      `${label} exact coverage receipts`,
    );
    assert.equal(
      original.verifiedRelationshipCount,
      original.relationships.filter(({ current, withinWindow }) => current && withinWindow).length,
      `${label} verified current relationships`,
    );
    assert.equal(
      original.hasVerifiedRevert,
      original.verifiedRelationshipCount > 0,
      `${label} verified flag`,
    );
  }
  assert.equal(summary.observedMergeCount, rows.length, `${label} observed originals`);
  assert.equal(summary.coveredMatureCount, covered.length, `${label} covered denominator`);
  assert.equal(summary.revertedCoveredCount, numerator, `${label} revert numerator`);
  assert.equal(
    summary.verifiedRevertedCount,
    rows.filter(({ hasVerifiedRevert }) => hasVerifiedRevert).length,
    `${label} all verified originals`,
  );
  assert.equal(
    summary.immatureCount,
    rows.filter(({ status }) => status === "immature").length,
    `${label} immature`,
  );
  assert.equal(
    summary.partialCount,
    rows.filter(({ status }) => status === "partial").length,
    `${label} partial`,
  );
  assert.equal(
    summary.ambiguousCount,
    rows.filter(({ status }) => status === "ambiguous").length,
    `${label} ambiguous`,
  );
  closeInValue(
    summary.revertRate,
    covered.length > 0 ? numerator / covered.length : null,
    `${label} revert fraction`,
  );
}

export function assertFactoryOutcomeExportReconciles(document: unknown) {
  for (const { key, summaries, evidence } of exportSchema.parse(document).periods) {
    for (const label of phase.options) {
      const rows = evidence.flow.filter((row) => row.phase === label);
      const summary = summaries.flow.flow[label];
      assert(summary, `${key} ${label} phase summary`);
      closeInValue(
        summary.seconds,
        rows.reduce((total, row) => total + row.seconds, 0),
        `${key} ${label} seconds`,
      );
      assert.equal(summary.segments, rows.length, `${key} ${label} segments`);
      assert.equal(
        summary.sessions,
        new Set(rows.map(({ sessionId }) => sessionId)).size,
        `${key} ${label} sessions`,
      );
    }
    for (const rows of Map.groupBy(evidence.flow, ({ sessionId }) => sessionId).values()) {
      let previousEnd = -Infinity;
      for (const row of rows.toSorted(
        (a, b) => epochMicroseconds(a.startedAt) - epochMicroseconds(b.startedAt),
      )) {
        const start = epochMicroseconds(row.startedAt);
        const end = epochMicroseconds(row.endedAt);
        assert(start >= previousEnd, `${key} flow intervals are disjoint`);
        assert.equal(
          new Set(row.observationIds).size,
          row.observationIds.length,
          `${key} distinct phase source IDs`,
        );
        closeInValue(row.seconds, (end - start) / 1_000_000, `${key} clipped interval duration`);
        previousEnd = end;
      }
    }
    reconcileDuration(summaries.flow.merge, evidence.merge, `${key} merge`);
    reconcileDuration(summaries.flow.deployment, evidence.deployment, `${key} deployment`);
    const merges = new Set(evidence.costMerges.map(({ mergeId }) => mergeId)).size;
    assert.equal(merges, evidence.costMerges.length, `${key} unique cost denominator receipts`);
    assert.equal(summaries.cost.mergeCohort.observedMergeCount, merges, `${key} cost denominator`);
    reconcileCost(
      summaries.cost.costs.delivery,
      evidence.deliveryCost,
      "delivery",
      merges,
      `${key} delivery cost`,
    );
    reconcileCost(
      summaries.cost.costs.operating,
      evidence.operatingCost,
      "operating",
      merges,
      `${key} operating cost`,
    );
    reconcileThroughput(summaries.throughput, evidence.throughput, `${key} throughput`);
    reconcileReverts(summaries.revert, evidence.revert, `${key} reverts`);
  }
}
