import { describe, expect, it } from "vitest";

import {
  SESSION_REVIEW_PAYLOAD_TARGET_BYTES,
  serializeSessionReviewData,
  type SessionReviewData,
} from "@/features/sessions/detail/data";
import { approximatePayloadSizeBytes } from "@/lib/server-timing";

const SEEDED_SESSION_18_BASELINE_RPC_BYTES = 10_603;

function makeRpcPayload() {
  return {
    activity: {
      repository: null,
      sessionGithubRepositoryId: "repo-private-to-server",
      sessionId: "session-18",
      workspaceId: "workspace-private-to-server",
    },
    creatorDisplayName: "Anant Jain",
    currentMember: { preferences: "must-not-cross" },
    members: [{ fullName: "must-not-cross" }],
    session: {
      archivedAt: null,
      artifacts: [
        {
          createdAt: "2026-07-11T05:32:06.176Z",
          payload: "# Land\n\nMerged and deployed; storage bucket policies configured.",
          stageSlug: "land",
          version: 1,
        },
      ],
      createdAt: "2026-07-06T05:32:06.176Z",
      currentArtifactVersion: 1,
      currentStageId: "stage-land",
      currentStageName: "must-not-cross",
      currentStagePosition: 4,
      currentStageSlug: "land",
      id: "session-18",
      linearIssueId: null,
      linearIssueUrl: null,
      number: 18,
      phaseCompletions: [{ completedAt: "2026-07-06T17:32:06.176Z", stageSlug: "plan" }],
      phaseStatus: "awaiting_review" as const,
      pipeline: {
        id: "pipeline-private-to-server",
        isDefault: true,
        name: "Default",
        operatingRulesMd: "must-not-cross",
        stages: [
          {
            approverMemberIds: ["must-not-cross"],
            description: "Merge the approved change once CI is green.",
            id: "stage-land",
            name: "Land",
            pipelineId: "pipeline-private-to-server",
            position: 4,
            promptTemplateMd: "must-not-cross",
            slug: "land",
          },
        ],
      },
      pipelineId: "pipeline-private-to-server",
      promptMd: "Add workspace branding.",
      pullRequestCount: 0,
      pullRequests: [],
      rejectionCount: 1,
      title: "Custom workspace branding and logo upload",
      updatedAt: "2026-07-12T05:32:06.176Z",
      workspaceId: "workspace-private-to-server",
    },
    sessionGithubRepositoryId: "repo-private-to-server",
    workspaceSlug: "acme-corp",
  };
}

describe("session review RSC contract", () => {
  it("constructs only the documented client fields without database spreads", () => {
    const review: SessionReviewData = serializeSessionReviewData(makeRpcPayload());

    expect(Object.keys(review)).toEqual(["creatorDisplayName", "session", "workspaceSlug"]);
    expect(Object.keys(review.session)).toEqual([
      "archivedAt",
      "artifacts",
      "createdAt",
      "currentArtifactVersion",
      "currentStageId",
      "currentStageSlug",
      "id",
      "linearIssueId",
      "linearIssueUrl",
      "number",
      "phaseCompletions",
      "phaseStatus",
      "pipeline",
      "promptMd",
      "pullRequests",
      "title",
      "updatedAt",
    ]);
    expect(Object.keys(review.session.pipeline)).toEqual(["stages"]);
    expect(Object.keys(review.session.pipeline.stages[0]!)).toEqual([
      "description",
      "id",
      "name",
      "position",
      "slug",
    ]);
    expect(JSON.stringify(review)).not.toContain("must-not-cross");
    expect(JSON.stringify(review)).not.toContain("private-to-server");
  });

  it("stays below the documented target and 25% under the seeded baseline", () => {
    const reviewBytes = approximatePayloadSizeBytes(serializeSessionReviewData(makeRpcPayload()));

    expect(reviewBytes).not.toBeNull();
    expect(reviewBytes!).toBeLessThanOrEqual(SESSION_REVIEW_PAYLOAD_TARGET_BYTES);
    expect(reviewBytes!).toBeLessThanOrEqual(SEEDED_SESSION_18_BASELINE_RPC_BYTES * 0.75);
  });
});
