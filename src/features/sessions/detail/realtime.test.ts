import { describe, expect, it } from "vitest";

import {
  mergeArtifactRealtimeRow,
  mergeCompletionRealtimeRow,
  mergeSessionRealtimeRow,
} from "@/features/sessions/detail/realtime";
import type { SessionDetail } from "@/features/sessions/types";

const baseSession: SessionDetail = {
  archivedAt: null,
  artifacts: [],
  createdAt: "2026-05-21T13:00:00.000Z",
  currentArtifactVersion: 0,
  currentStageId: "stage-product",
  currentStageName: "Product",
  currentStageSlug: "product",
  id: "sess-1",
  linearIssueId: null,
  linearIssueUrl: null,
  number: 7,
  phaseCompletions: [],
  phaseStatus: "agent_generating",
  pipeline: {
    id: "pipe-1",
    isDefault: true,
    name: "Default",
    operatingRulesMd: "",
    stages: [
      {
        approverMemberIds: [],
        description: "Product work",
        id: "stage-product",
        name: "Product",
        pipelineId: "pipe-1",
        position: 1,
        promptTemplateMd: "",
        slug: "product",
      },
      {
        approverMemberIds: [],
        description: "Design work",
        id: "stage-design",
        name: "Design",
        pipelineId: "pipe-1",
        position: 2,
        promptTemplateMd: "",
        slug: "design",
      },
    ],
  },
  pipelineId: "pipe-1",
  promptMd: "Build realtime updates",
  pullRequestCount: 0,
  pullRequests: [],
  rejectionCount: 0,
  title: "Realtime updates",
  updatedAt: "2026-05-21T13:00:00.000Z",
  workspaceId: "ws-1",
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
      pipeline_id: "pipe-1",
      prompt_md: baseSession.promptMd,
      rejection_count: 1,
      title: "Realtime updates v2",
      updated_at: "2026-05-21T13:05:00.000Z",
      workspace_id: "ws-1",
    });

    expect(next.currentStageId).toBe("stage-design");
    expect(next.currentStageName).toBe("Design");
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
