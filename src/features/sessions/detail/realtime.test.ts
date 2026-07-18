import { describe, expect, it } from "vitest";

import {
  mergeArtifactRealtimeRow,
  mergeCompletionRealtimeRow,
  mergeSessionRealtimeRow,
} from "@/features/sessions/detail/realtime";
import type { SessionReviewSession } from "@/features/sessions/detail/data";

const baseSession: SessionReviewSession = {
  archivedAt: null,
  artifacts: [],
  createdAt: "2026-05-21T13:00:00.000Z",
  currentArtifactVersion: 0,
  currentStageId: "stage-product",
  currentStageSlug: "product",
  id: "sess-1",
  linearIssueId: null,
  linearIssueUrl: null,
  number: 7,
  phaseCompletions: [],
  phaseStatus: "agent_generating",
  pipeline: {
    stages: [
      {
        description: "Product work",
        id: "stage-product",
        name: "Product",
        position: 1,
        slug: "product",
      },
      {
        description: "Design work",
        id: "stage-design",
        name: "Design",
        position: 2,
        slug: "design",
      },
    ],
  },
  promptMd: "Build realtime updates",
  pullRequests: [],
  title: "Realtime updates",
  updatedAt: "2026-05-21T13:00:00.000Z",
};

describe("session detail realtime helpers", () => {
  it("merges session row updates and resolves the new current stage", () => {
    const next = mergeSessionRealtimeRow(baseSession, {
      archived_at: null,
      created_at: baseSession.createdAt,
      current_artifact_version: 1,
      current_stage_id: "stage-design",
      id: "sess-1",
      linear_issue_id: "WAL-12",
      linear_issue_url: "https://linear.app/acme/issue/WAL-12",
      number: 7,
      phase_status: "awaiting_review",
      prompt_md: baseSession.promptMd,
      title: "Realtime updates v2",
      updated_at: "2026-05-21T13:05:00.000Z",
    });

    expect(next.currentStageId).toBe("stage-design");
    expect(next.currentStageSlug).toBe("design");
    expect(next.currentArtifactVersion).toBe(1);
    expect(next.phaseStatus).toBe("awaiting_review");
    expect(next.title).toBe("Realtime updates v2");
  });

  it("upserts artifact rows into the session artifact list", () => {
    const next = mergeArtifactRealtimeRow(baseSession, {
      artifact_json: "# Product spec",
      created_at: "2026-05-21T13:06:00.000Z",
      session_id: "sess-1",
      stage_slug: "product",
      version: 1,
    });

    expect(next.artifacts).toEqual([
      {
        createdAt: "2026-05-21T13:06:00.000Z",
        payload: "# Product spec",
        stageSlug: "product",
        version: 1,
      },
    ]);
  });

  it("upserts phase completion rows into the stage rail inputs", () => {
    const next = mergeCompletionRealtimeRow(baseSession, {
      completed_at: "2026-05-21T13:07:00.000Z",
      session_id: "sess-1",
      stage_slug: "product",
    });

    expect(next.phaseCompletions).toEqual([
      {
        completedAt: "2026-05-21T13:07:00.000Z",
        stageSlug: "product",
      },
    ]);
  });
});
