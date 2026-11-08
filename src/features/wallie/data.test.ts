import { describe, expect, it } from "vitest";

import {
  buildWallieSessionData,
  mapAgentRunMessageRow,
  mergeWallieRuns,
  nextAttemptOrdinal,
  normalizeWallieRuns,
  upsertWallieRunMessage,
} from "@/features/wallie/data";
import { parseRunFailure } from "@/lib/pipeline/run-failure";
import type { WallieRun } from "@/features/wallie/types";

function run(
  id: string,
  createdAt = "2026-07-18T12:00:00.000Z",
  overrides: Partial<WallieRun> = {},
): WallieRun {
  return {
    attemptCount: 1,
    branchName: null,
    canCancel: false,
    canRetry: false,
    createdAt,
    finishedAt: createdAt,
    id,
    isActive: false,
    isTerminal: true,
    lastActivityAt: createdAt,
    messages: [],
    modelName: "gpt-5",
    modelProvider: "codex",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "code",
    sandboxId: null,
    sandboxProvider: null,
    startedAt: createdAt,
    stageId: null,
    stageName: "Build",
    stageSlug: "build",
    status: "success",
    updatedAt: createdAt,
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalCostUsd: null,
      tokenProvenance: "unavailable",
      costProvenance: "unavailable",
      finalized: true,
    },
    ...overrides,
  };
}

describe("Wallie run history data", () => {
  const persistedRun = {
    attemptCount: 1,
    branch_name: null,
    created_at: "2026-07-18T12:00:00.000Z",
    cost_provenance: "unavailable",
    finished_at: "2026-07-18T12:01:00.000Z",
    id: "run-1",
    input_tokens: null,
    output_tokens: null,
    total_cost_usd: null,
    token_provenance: "unavailable",
    usage_finalized_at: "2026-07-18T12:01:00.000Z",
    last_activity_at: "2026-07-18T12:01:00.000Z",
    model_name: "gpt-5",
    model_provider: "codex",
    run_type: "code",
    sandbox_id: null,
    sandbox_provider: null,
    started_at: "2026-07-18T12:00:00.000Z",
    stage_id: "stage-build",
    stage_name: "Build",
    stage_slug: "build",
    status: "error",
    triggered_by_member_id: null,
    updated_at: "2026-07-18T12:01:00.000Z",
  } satisfies Parameters<typeof buildWallieSessionData>[0]["runs"][number];

  function sessionData(messages: Parameters<typeof buildWallieSessionData>[0]["messages"]) {
    return buildWallieSessionData({
      sessionGithubRepositoryId: null,
      memberIndex: new Map(),
      messages,
      repository: null,
      requiresVercelSandbox: false,
      runs: [persistedRun],
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: null,
        projectId: null,
        projectName: null,
        status: "missing",
        teamId: null,
      },
    });
  }

  it.each([
    ["configuration", "credentials"],
    ["agent_exit", "agent_exit"],
    ["timeout", "timeout"],
    ["budget", "budget"],
    ["publication", "publication"],
  ])(
    "maps recorded %s causes without treating terminal metadata as loaded activity",
    (category, code) => {
      const data = sessionData([
        {
          agent_run_id: "run-1",
          created_at: persistedRun.finished_at,
          id: "failure-1",
          kind: "run_failure",
          message_md: JSON.stringify({ version: 1, category, code }),
        },
      ]);
      expect(data.runs[0]?.failure).toMatchObject({ category, code });
      expect(data.runs[0]?.messages).toEqual([]);
      expect(data.loadedMessageRunIds).toEqual([]);
    },
  );

  it("leaves missing and malformed legacy causes unavailable instead of inferring from test output", () => {
    for (const terminal of [
      undefined,
      "not json",
      '{"version":1,"category":"timeout","code":"credentials","token":"private"}',
    ]) {
      const messages = [
        {
          agent_run_id: "run-1",
          created_at: persistedRun.finished_at,
          id: "agent-error",
          kind: "error",
          message_md: "Tests failed while checking the build.",
        },
      ];
      if (terminal)
        messages.push({
          ...messages[0]!,
          id: "failure-1",
          kind: "run_failure",
          message_md: terminal,
        });
      const data = sessionData(messages);
      expect(data.runs[0]?.failure).toBeNull();
      expect(data.runs[0]?.messages.map((message) => message.id)).toEqual(["agent-error"]);
      expect(JSON.stringify(data)).not.toContain("private");
    }
  });

  it("sanitizes stored diagnostics before returning the client read model", () => {
    const diagnostic = {
      created_at: persistedRun.finished_at,
      id: "diagnostic-1",
      kind: "error",
      message_md: 'Agent exited with code 7; API_KEY="private-provider-value"',
    };
    const mapped = mapAgentRunMessageRow(diagnostic);
    const data = sessionData([{ ...diagnostic, agent_run_id: persistedRun.id }]);

    expect(mapped.messageMd).toContain("Agent exited with code 7");
    expect(mapped.messageMd).toContain("[redacted]");
    expect(JSON.stringify(data)).not.toContain("private-provider-value");
    expect(data.runs[0]?.failure).toBeNull();
  });

  it("preserves the terminal cause through activity loading and partial metadata reconciliation", () => {
    const failed = run("run-1", undefined, { status: "error" });
    const terminal = JSON.stringify({ version: 1, category: "publication", code: "publication" });
    const withFailure = upsertWallieRunMessage([failed], {
      agentRunId: failed.id,
      message: {
        id: "terminal",
        createdAt: failed.createdAt,
        kind: "run_failure",
        messageMd: terminal,
      },
    });
    const withAgentError = upsertWallieRunMessage(withFailure, {
      agentRunId: failed.id,
      message: {
        id: "test",
        createdAt: failed.createdAt,
        kind: "error",
        messageMd: "Tests failed.",
      },
    });
    const reconciled = mergeWallieRuns(withAgentError, [failed]);
    expect(reconciled[0]?.failure).toEqual(parseRunFailure(terminal));
    expect(reconciled[0]?.messages.map((message) => message.id)).toEqual(["test"]);
  });

  it("retains persisted execution branches while merging partial metadata", () => {
    const persisted = run("run-1", undefined, { branchName: "wallie/build-original-attempt" });
    const incoming = run("run-1", undefined, { branchName: null, stageSlug: "renamed" });
    expect(mergeWallieRuns([persisted], [incoming])[0]?.branchName).toBe(persisted.branchName);
  });

  it("uses id as the deterministic descending tie-breaker", () => {
    expect(
      normalizeWallieRuns([run("run-a"), run("run-c"), run("run-b")]).map((row) => row.id),
    ).toEqual(["run-c", "run-b", "run-a"]);
  });

  it("preserves unaffected run references so memoized rows skip message updates", () => {
    const first = run("run-1");
    const second = run("run-2", "2026-07-18T11:00:00.000Z");
    const next = upsertWallieRunMessage([first, second], {
      agentRunId: first.id,
      message: {
        createdAt: "2026-07-18T12:01:00.000Z",
        id: "message-1",
        kind: "progress",
        messageMd: "Working",
      },
    });

    expect(next[0]).not.toBe(first);
    expect(next[1]).toBe(second);
  });

  it("deduplicates reconciled run ids while retaining cached messages", () => {
    const cached = {
      ...run("run-1"),
      messages: [
        {
          createdAt: "2026-07-18T12:01:00.000Z",
          id: "message-1",
          kind: "progress",
          messageMd: "Cached",
        },
      ],
    };
    const reconciled = mergeWallieRuns(
      [cached],
      [run("run-1", cached.createdAt, { status: "error", updatedAt: "2026-07-18T12:02:00.000Z" })],
    );

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.status).toBe("error");
    expect(reconciled[0]?.messages).toEqual(cached.messages);
  });

  it("ignores stale reconciliation snapshots that lose to newer realtime updates", () => {
    const live = run("run-1", "2026-07-18T12:00:00.000Z", {
      status: "success",
      updatedAt: "2026-07-18T12:05:00.000Z",
    });
    const stale = run("run-1", "2026-07-18T12:00:00.000Z", {
      status: "running",
      updatedAt: "2026-07-18T12:04:00.000Z",
    });

    expect(mergeWallieRuns([live], [stale])[0]?.status).toBe("success");
  });

  it("derives the next attempt ordinal for a newly inserted stage retry", () => {
    const first = run("run-1", "2026-07-18T12:00:00.000Z", {
      attemptCount: 1,
      stageId: "stage-build",
      stageSlug: "build",
    });
    const second = run("run-2", "2026-07-18T12:05:00.000Z", {
      attemptCount: 2,
      stageId: "stage-build",
      stageSlug: "build",
    });

    expect(nextAttemptOrdinal([first, second], { id: "run-3", stageId: "stage-build" })).toBe(3);
    expect(nextAttemptOrdinal([first, second], { id: "run-1", stageId: "stage-build" })).toBe(1);
    expect(nextAttemptOrdinal([first], { id: "run-plan", stageId: "stage-plan" })).toBe(1);
  });

  it("keeps attempt ordinals continuous when a stage slug is renamed", () => {
    const beforeRename = run("run-1", "2026-07-18T12:00:00.000Z", {
      attemptCount: 2,
      stageId: "stage-build",
      stageSlug: "build",
    });

    expect(
      nextAttemptOrdinal([beforeRename], {
        id: "run-after-rename",
        stageId: "stage-build",
      }),
    ).toBe(3);
  });
});
