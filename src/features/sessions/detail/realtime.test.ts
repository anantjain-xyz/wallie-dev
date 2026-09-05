import { describe, expect, it } from "vitest";

import {
  reconcileSessionRecoverySnapshot,
  mergeArtifactRealtimeRow,
  mergeCompletionRealtimeRow,
  mergeSessionRealtimeRow,
  removeArtifactRealtimeRow,
  removeCompletionRealtimeRow,
  removePullRequestRealtimeRow,
} from "@/features/sessions/detail/realtime";
import type { SessionReviewSession } from "@/features/sessions/detail/data";

const baseSession: SessionReviewSession = {
  archivedAt: null,
  artifacts: [],
  attachments: [],
  createdAt: "2026-05-21T13:00:00.000Z",
  currentArtifactVersion: 0,
  currentStageId: "stage-product",
  currentStageSlug: "product",
  id: "sess-1",
  linearIssueId: null,
  linearIssueUrl: null,
  number: 7,
  phaseCompletions: [],
  phaseStatus: "in_progress",
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
      rejection_count: 0,
      title: "Realtime updates v2",
      updated_at: "2026-05-21T13:05:00.000Z",
    });

    expect(next.currentStageId).toBe("stage-design");
    expect(next.currentStageSlug).toBe("design");
    expect(next.currentArtifactVersion).toBe(1);
    expect(next.phaseStatus).toBe("awaiting_review");
    expect(next.title).toBe("Realtime updates v2");
  });

  it("ignores realtime echoes and out-of-order session rows", () => {
    const row = {
      archived_at: null,
      created_at: baseSession.createdAt,
      current_artifact_version: 0,
      current_stage_id: "stage-product",
      id: "sess-1",
      linear_issue_id: null,
      linear_issue_url: null,
      number: 7,
      phase_status: "in_progress" as const,
      pipeline_id: "pipe-1",
      prompt_md: baseSession.promptMd,
      rejection_count: 0,
      title: "Stale title",
      updated_at: baseSession.updatedAt,
      workspace_id: "ws-1",
    };

    expect(mergeSessionRealtimeRow(baseSession, row)).toBe(baseSession);
    expect(
      mergeSessionRealtimeRow(baseSession, {
        ...row,
        updated_at: "2026-05-21T12:59:59.000Z",
      }),
    ).toBe(baseSession);
  });

  it("upserts artifact rows into the session artifact list", () => {
    const next = mergeArtifactRealtimeRow(baseSession, {
      artifact_json: "# Product spec",
      created_at: "2026-05-21T13:06:00.000Z",
      id: "artifact-1",
      session_id: "sess-1",
      stage_slug: "product",
      version: 1,
    });

    expect(next.artifacts).toEqual([
      {
        createdAt: "2026-05-21T13:06:00.000Z",
        id: "artifact-1",
        payload: "# Product spec",
        stageSlug: "product",
        version: 1,
      },
    ]);
  });

  it("upserts phase completion rows into the stage rail inputs", () => {
    const next = mergeCompletionRealtimeRow(baseSession, {
      completed_at: "2026-05-21T13:07:00.000Z",
      id: "completion-1",
      session_id: "sess-1",
      stage_id: "stage-1",
      stage_slug: "product",
    });

    expect(next.phaseCompletions).toEqual([
      {
        completedAt: "2026-05-21T13:07:00.000Z",
        id: "completion-1",
        stageId: "stage-1",
        stageSlug: "product",
      },
    ]);
  });

  it("removes realtime rows by primary key when DELETE only includes replica identity", () => {
    const withRows: SessionReviewSession = {
      ...baseSession,
      artifacts: [
        {
          createdAt: "2026-05-21T13:06:00.000Z",
          id: "artifact-1",
          payload: "# Product spec",
          stageSlug: "product",
          version: 1,
        },
      ],
      phaseCompletions: [
        {
          completedAt: "2026-05-21T13:07:00.000Z",
          id: "completion-1",
          stageSlug: "product",
        },
      ],
    };

    expect(removeArtifactRealtimeRow(withRows, { id: "artifact-1" }).artifacts).toEqual([]);
    expect(removeCompletionRealtimeRow(withRows, { id: "completion-1" }).phaseCompletions).toEqual(
      [],
    );
  });

  it("removes a pull request DELETE by id without reading absent timestamp fields", () => {
    const withPullRequest: SessionReviewSession = {
      ...baseSession,
      pullRequests: [
        {
          id: "pr-1",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/acme/app/pull/42",
        },
      ],
    };

    expect(removePullRequestRealtimeRow(withPullRequest, { id: "pr-1" }).pullRequests).toEqual([]);
  });
});

it("upserts a renamed stage completion by durable identity and preserves distinct stages", () => {
  const session = {
    ...baseSession,
    phaseCompletions: [
      {
        id: "old-completion",
        stageId: "stage-1",
        stageSlug: "old-slug",
        completedAt: "2026-05-21T13:00:00.000Z",
      },
      {
        id: "other-completion",
        stageId: "stage-2",
        stageSlug: "new-slug",
        completedAt: "2026-05-21T13:00:00.000Z",
      },
    ],
  };
  const next = mergeCompletionRealtimeRow(session, {
    id: "new-completion",
    stage_id: "stage-1",
    stage_slug: "new-slug",
    session_id: "sess-1",
    completed_at: "2026-05-21T14:00:00.000Z",
  });
  expect(next.phaseCompletions).toHaveLength(2);
  expect(next.phaseCompletions.map((completion) => completion.id)).toEqual([
    "other-completion",
    "new-completion",
  ]);
});

describe("recovery snapshots", () => {
  const pr = (id: string, number = 1) => ({
    id,
    pullRequestNumber: number,
    pullRequestUrl: `https://github.com/acme/app/pull/${number}`,
  });

  it("keeps live child changes while accepting missed changes despite a newer session row", () => {
    const baseline = {
      ...baseSession,
      pullRequests: [pr("updated"), pr("deleted"), pr("missed-delete")],
    };
    const current = {
      ...baseline,
      title: "New live title",
      updatedAt: "2026-05-21T16:00:00.000Z",
      pullRequests: [pr("updated", 2), pr("live-add"), pr("missed-delete")],
    };
    const incoming = {
      ...baseline,
      pullRequests: [pr("updated"), pr("deleted"), pr("missed-add")],
    };
    const result = reconcileSessionRecoverySnapshot(baseline, current, incoming);
    expect(result.title).toBe("New live title");
    expect(result.pullRequests).toEqual([pr("updated", 2), pr("missed-add"), pr("live-add")]);
  });

  it("does not resurrect a child added and deleted during an in-flight refresh", () => {
    const incoming = { ...baseSession, pullRequests: [pr("transient")] };
    const result = reconcileSessionRecoverySnapshot(baseSession, baseSession, incoming, {
      pullRequests: new Set(["transient"]),
    });
    expect(result.pullRequests).toEqual([]);
  });

  it("preserves a live restoration even when the current row matches the baseline", () => {
    const baseline = { ...baseSession, pullRequests: [pr("restored")] };
    const result = reconcileSessionRecoverySnapshot(baseline, baseline, baseSession, {
      pullRequests: new Set(["restored"]),
    });
    expect(result.pullRequests).toEqual([pr("restored")]);
  });

  it("reconciles artifacts and completions independently of the core timestamp", () => {
    const artifact = {
      id: "artifact",
      stageSlug: "product",
      version: 1,
      payload: "old",
      createdAt: "2026-05-21T13:00:00Z",
    };
    const completion = {
      id: "completion",
      stageId: "stage-product",
      stageSlug: "product",
      completedAt: "2026-05-21T13:00:00Z",
    };
    const baseline = { ...baseSession, artifacts: [artifact], phaseCompletions: [completion] };
    const current = {
      ...baseline,
      artifacts: [{ ...artifact, payload: "live" }],
      phaseCompletions: [],
    };
    const incoming = {
      ...baseline,
      artifacts: [artifact, { ...artifact, id: "missed-artifact", version: 2 }],
      phaseCompletions: [
        completion,
        { ...completion, id: "missed-completion", stageId: "stage-design", stageSlug: "design" },
      ],
    };
    const result = reconcileSessionRecoverySnapshot(baseline, current, incoming);
    expect(result.artifacts.map((row) => row.payload)).toEqual(["live", "old"]);
    expect(result.phaseCompletions.map((row) => row.id)).toEqual(["missed-completion"]);
    // A later quiet refresh must be allowed to supersede the prior live edit.
    expect(reconcileSessionRecoverySnapshot(result, result, incoming).artifacts[0]?.payload).toBe(
      "old",
    );
  });
});
