import { z } from "zod/v4";

import { seedFactoryAnalytics } from "./factory-analytics";

// Compute the oracle from the fixture's declared inputs, independent of the
// dashboard, export serializer, and SQL that projects persisted observations.
const secondsPerHour = 3600;
const expected = {
  observedMergeCount: 4,
  mergeMeasured: 4,
  mergeUnknown: 1,
  deploymentMeasured: 1,
  mergeMedianSeconds: ((3 + 5) / 2) * secondsPerHour,
  correctedMergeMedianSeconds: ((3.5 + 5) / 2) * secondsPerHour,
  deploymentMedianSeconds: 4 * secondsPerHour,
  correctedDeploymentMedianSeconds: 5 * secondsPerHour,
  knownCostUsd: 12.5 + 2.5,
  costPerObservedMergeUsd: (12.5 + 2.5) / 4,
  measuredAttempts: 1,
  estimatedAttempts: 1,
  unavailableAttempts: 1,
  matureCoveredCount: 2,
  revertedCoveredCount: 1,
  ambiguousRevertCount: 1,
  immatureRevertCount: 1,
  revertRate: 1 / 2,
  previousObservedMergeCount: 0,
  browserAttributedMerges: 1,
  unknownSourceMerges: 3,
  phaseSeconds: {
    queued: 25 * 60,
    active: 92 * 60,
    blocked: 10 * 60,
    review: 20 * 60,
    delivery: 30 * 60,
    unknown: 3 * 60,
  },
  correctedDeliveryPhaseSeconds: 60 * 60,
};

const releaseReceipts = z.object({
  verifiedRevertMergeId: z.uuid(),
  ambiguousRevertMergeId: z.uuid(),
  verifiedRelationshipId: z.uuid(),
  revertCoverageId: z.uuid(),
  estimatedRunId: z.uuid(),
  browserRequestReceiptId: z.uuid(),
  unknownSessionId: z.uuid(),
  unknownSessionNumber: z.literal(84),
  unlinkedDeploymentObservationId: z.uuid(),
  otherWorkspaceId: z.uuid(),
  otherWorkspaceSlug: z.string(),
  otherFactoryId: z.uuid(),
});
const correctedReceipts = z.object({
  mergeObservationId: z.uuid(),
  deploymentObservationId: z.uuid(),
});

export async function seedFactoryOutcomeRelease(baseURL: string | undefined) {
  const base = await seedFactoryAnalytics(baseURL, 56);

  function run(operation: "seed" | "correct" | "sibling" | "cleanup") {
    return base.runFixtureFile("factory-outcome-release.sql", {
      qualify_seed: String(operation === "seed"),
      qualify_correct: String(operation === "correct"),
      qualify_sibling: String(operation === "sibling"),
      workspace_id: base.workspaceId,
      factory_id: base.factoryId,
      sibling_factory_id: base.siblingFactoryId,
      owner_id: base.ownerId,
      owner_email: base.ownerEmail,
      slug: base.slug,
      today: base.to,
    });
  }

  async function cleanup() {
    try {
      await run("cleanup");
    } finally {
      await base.cleanup();
    }
  }
  try {
    const receipts = releaseReceipts.parse(await run("seed"));
    await base.drainProjections();
    return {
      ...base,
      ...receipts,
      expected,
      cleanup,
      async applyLateCorrection() {
        return correctedReceipts.parse(await run("correct"));
      },
      async observeSiblingPendingRequest() {
        return z.object({ sessionId: z.uuid() }).parse(await run("sibling")).sessionId;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
