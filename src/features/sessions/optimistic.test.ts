import { describe, expect, it, vi } from "vitest";

import {
  applySessionMutationPatch,
  compareSessionTimestamps,
  reconcileSessionMutationPatch,
  rollbackSessionMutationPatch,
  runOptimisticMutation,
} from "@/features/sessions/optimistic";
import type { SessionDetail } from "@/features/sessions/types";

const session: SessionDetail = {
  archivedAt: null,
  artifacts: [],
  createdAt: "2026-07-17T12:00:00.000Z",
  currentArtifactVersion: 1,
  currentStageId: "stage-plan",
  currentStageName: "Plan",
  currentStagePosition: 0,
  currentStageSlug: "plan",
  id: "session-1",
  linearIssueId: null,
  linearIssueUrl: null,
  number: 1,
  phaseCompletions: [],
  phaseStatus: "awaiting_review",
  pipeline: {
    id: "pipeline-1",
    isDefault: true,
    name: "Default",
    operatingRulesMd: "",
    stages: [
      {
        approverMemberIds: [],
        description: "",
        id: "stage-plan",
        name: "Plan",
        pipelineId: "pipeline-1",
        position: 0,
        promptTemplateMd: "",
        slug: "plan",
      },
      {
        approverMemberIds: [],
        description: "",
        id: "stage-build",
        name: "Build",
        pipelineId: "pipeline-1",
        position: 1,
        promptTemplateMd: "",
        slug: "build",
      },
    ],
  },
  pipelineId: "pipeline-1",
  promptMd: "Ship it",
  pullRequestCount: 0,
  pullRequests: [],
  rejectionCount: 0,
  title: "Original",
  updatedAt: "2026-07-17T12:00:00.000Z",
  workspaceId: "workspace-1",
};

describe("optimistic session mutations", () => {
  it("preserves sub-millisecond timestamp ordering", () => {
    expect(
      compareSessionTimestamps("2026-07-17T12:00:00.123789Z", "2026-07-17T12:00:00.123456Z"),
    ).toBeGreaterThan(0);
    expect(
      reconcileSessionMutationPatch(
        { ...session, updatedAt: "2026-07-17T12:00:00.123456Z" },
        {
          title: "Microsecond-newer title",
          updatedAt: "2026-07-17T12:00:00.123789Z",
        },
      ),
    ).toMatchObject({
      title: "Microsecond-newer title",
      updatedAt: "2026-07-17T12:00:00.123789Z",
    });
  });

  it("applies optimistic state before a delayed response resolves", async () => {
    let resolveResponse!: (value: { title: string }) => void;
    const response = new Promise<{ title: string }>((resolve) => {
      resolveResponse = resolve;
    });
    const events: string[] = [];

    const mutation = runOptimisticMutation({
      optimistic: () => events.push("optimistic"),
      mutate: () => response,
      commit: ({ title }) => events.push(`commit:${title}`),
      rollback: () => events.push("rollback"),
    });

    expect(events).toEqual(["optimistic"]);
    resolveResponse({ title: "Server title" });
    await mutation;
    expect(events).toEqual(["optimistic", "commit:Server title"]);
  });

  it("rolls back a failed mutation", async () => {
    const rollback = vi.fn();

    await expect(
      runOptimisticMutation({
        optimistic: vi.fn(),
        mutate: () => Promise.reject(new Error("nope")),
        commit: vi.fn(),
        rollback,
      }),
    ).rejects.toThrow("nope");
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("does not roll back a field already replaced by newer state", () => {
    const optimistic = { title: "Optimistic" };
    const newer = applySessionMutationPatch(session, { title: "Realtime newer" });

    expect(rollbackSessionMutationPatch(newer, optimistic, { title: session.title }).title).toBe(
      "Realtime newer",
    );
  });

  it("rolls back matching optimistic fields after an unrelated timestamp update", () => {
    const optimistic = { phaseStatus: "agent_generating" as const };
    const optimisticSession = applySessionMutationPatch(session, optimistic);
    const concurrentlyUpdated = applySessionMutationPatch(optimisticSession, {
      title: "Newer title",
      updatedAt: "2026-07-17T13:00:00.000Z",
    });

    expect(
      rollbackSessionMutationPatch(concurrentlyUpdated, optimistic, {
        phaseStatus: session.phaseStatus,
        updatedAt: session.updatedAt,
      }),
    ).toMatchObject({
      phaseStatus: session.phaseStatus,
      title: "Newer title",
      updatedAt: "2026-07-17T13:00:00.000Z",
    });
  });

  it("resolves stage metadata when an approval advances", () => {
    const next = applySessionMutationPatch(session, {
      currentArtifactVersion: 0,
      currentStageId: "stage-build",
      phaseStatus: "agent_generating",
    });

    expect(next).toMatchObject({
      currentArtifactVersion: 0,
      currentStageName: "Build",
      currentStageSlug: "build",
      phaseStatus: "agent_generating",
    });
  });

  it("accepts a later same-timestamp stage row without letting its earlier echo regress state", () => {
    const intermediate = reconcileSessionMutationPatch(session, {
      phaseStatus: "approved",
      updatedAt: session.updatedAt,
    });
    expect(intermediate).toBe(session);

    const advanced = reconcileSessionMutationPatch(session, {
      currentArtifactVersion: 0,
      currentStageId: "stage-build",
      phaseStatus: "agent_generating",
      updatedAt: session.updatedAt,
    });
    expect(advanced).toMatchObject({
      currentStageId: "stage-build",
      phaseStatus: "agent_generating",
    });

    expect(
      reconcileSessionMutationPatch(advanced, {
        currentArtifactVersion: 1,
        currentStageId: "stage-plan",
        phaseStatus: "approved",
        updatedAt: session.updatedAt,
      }),
    ).toBe(advanced);
  });
});
