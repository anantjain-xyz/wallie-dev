import { describe, expect, it } from "vitest";

import {
  deliveryPolicyResponseSchema,
  deliveryPolicyUpdateSchema,
  deliveryRequirementsSchema,
  readyVerificationSummarySchema,
  type DeliveryRequirements,
} from "./contracts";

const requirements: DeliveryRequirements = {
  version: 1,
  deliveryMode: "code",
  requiredChecks: ["check:fast", "test"],
  minimumApprovals: 1,
  requireCodeOwnerReview: false,
  requireResolvedThreads: true,
  requiredEvidence: ["smoke"],
  freshnessSeconds: 3600,
  requireArtifactApprovalForDelivery: false,
};

describe("explicit versioned delivery requirements", () => {
  it("requires each requirement even when its configured value is empty or false", () => {
    for (const field of Object.keys(requirements)) {
      const incomplete: Record<string, unknown> = { ...requirements };
      delete incomplete[field];
      expect(deliveryRequirementsSchema.safeParse(incomplete).success, field).toBe(false);
    }
    expect(deliveryRequirementsSchema.parse(requirements)).toEqual(requirements);
  });

  it("supports a deliberate analysis policy without inventing a PR", () => {
    const analysis = {
      ...requirements,
      deliveryMode: "analysis",
      requiredChecks: [],
      minimumApprovals: 0,
      requiredEvidence: [],
    };
    expect(deliveryRequirementsSchema.parse(analysis)).toEqual(analysis);
    expect(deliveryPolicyResponseSchema.parse({ policy: null })).toEqual({ policy: null });
  });

  it.each([
    { version: 2 },
    { freshnessSeconds: 0 },
    { freshnessSeconds: 604_801 },
    { minimumApprovals: -1 },
    { minimumApprovals: 21 },
    { minimumApprovals: 1.5 },
    { requiredChecks: [" "] },
    { requiredChecks: ["CI", " CI "] },
    { requiredEvidence: ["smoke", "smoke"] },
    { requireCanonicalPr: false },
    { stageSlug: "build" },
  ])("rejects unsupported or ambiguous configuration: %j", (override) => {
    expect(deliveryRequirementsSchema.safeParse({ ...requirements, ...override }).success).toBe(
      false,
    );
  });

  it("requires a pipeline and optimistic revision and rejects caller-supplied authority", () => {
    const update = {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      expectedRevision: 0,
      requirements,
    };
    expect(deliveryPolicyUpdateSchema.parse(update)).toEqual(update);
    expect(deliveryPolicyUpdateSchema.safeParse({ ...update, expectedRevision: -1 }).success).toBe(
      false,
    );
    expect(deliveryPolicyUpdateSchema.safeParse({ ...update, actorUserId: "other" }).success).toBe(
      false,
    );
  });

  it("never treats absent access or incomplete outcomes as a Ready receipt", () => {
    const receipt = {
      githubAccess: "available",
      checks: "passed",
      reviews: "passed",
      evidence: "passed",
      threads: "passed",
    };
    expect(readyVerificationSummarySchema.parse(receipt)).toEqual(receipt);
    for (const field of Object.keys(receipt)) {
      const incomplete: Record<string, unknown> = { ...receipt };
      delete incomplete[field];
      expect(readyVerificationSummarySchema.safeParse(incomplete).success, field).toBe(false);
      expect(
        readyVerificationSummarySchema.safeParse({ ...receipt, [field]: "unknown" }).success,
      ).toBe(false);
    }
  });
});
