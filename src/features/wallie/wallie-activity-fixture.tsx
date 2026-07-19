"use client";

import { useMemo } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SessionWalliePanel } from "@/features/wallie/session-wallie-panel";
import type { WallieRun, WallieSessionData } from "@/features/wallie/types";
import type { Database } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

export type WallieActivityFixtureState =
  | "active"
  | "completed"
  | "disconnected"
  | "empty"
  | "failed"
  | "loading"
  | "queued"
  | "stalled";

const FIXED_NOW = "2026-07-18T18:00:00.000Z";
const SESSION_ID = "50000000-0000-4000-8000-000000000359";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000099";

const LONG_LOG =
  "npm warn deprecated inflight@1.0.6: This module is not supported, and will leak memory. Do not use it. Check out lru-cache for a better alternative that also supports a max size. ".repeat(
    4,
  );

function baseRun(overrides: Partial<WallieRun> = {}): WallieRun {
  return {
    attemptCount: 1,
    canCancel: false,
    canRetry: false,
    createdAt: "2026-07-18T17:40:00.000Z",
    finishedAt: null,
    id: "run-active",
    isActive: true,
    isTerminal: false,
    lastActivityAt: "2026-07-18T17:58:00.000Z",
    messages: [
      {
        createdAt: "2026-07-18T17:55:00.000Z",
        id: "msg-1",
        kind: "progress",
        messageMd: "Cloning repository acme/wallie",
      },
      {
        createdAt: "2026-07-18T17:57:00.000Z",
        id: "msg-2",
        kind: "log",
        messageMd: LONG_LOG.trim(),
      },
      {
        createdAt: "2026-07-18T17:58:00.000Z",
        id: "msg-3",
        kind: "progress",
        messageMd: "Installing dependencies",
      },
    ],
    modelName: "gpt-5",
    modelProvider: "codex",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "code",
    sandboxId: "sbx_fixture_359",
    sandboxProvider: "vercel",
    startedAt: "2026-07-18T17:45:00.000Z",
    stageId: "stage-build",
    stageName: "Build",
    stageSlug: "build",
    status: "running",
    updatedAt: "2026-07-18T17:58:00.000Z",
    ...overrides,
  };
}

function olderCompletedRun(): WallieRun {
  return baseRun({
    attemptCount: 1,
    canCancel: false,
    canRetry: false,
    createdAt: "2026-07-18T16:00:00.000Z",
    finishedAt: "2026-07-18T16:20:00.000Z",
    id: "run-older",
    isActive: false,
    isTerminal: true,
    lastActivityAt: "2026-07-18T16:20:00.000Z",
    messages: [
      {
        createdAt: "2026-07-18T16:10:00.000Z",
        id: "msg-older-1",
        kind: "completion",
        messageMd: "Plan artifact ready for review.",
      },
    ],
    startedAt: "2026-07-18T16:05:00.000Z",
    stageId: "stage-plan",
    stageName: "Plan",
    stageSlug: "plan",
    status: "success",
    updatedAt: "2026-07-18T16:20:00.000Z",
  });
}

function buildData(state: WallieActivityFixtureState): {
  data: WallieSessionData;
  delayMessagesMs: number | null;
  realtimeStatus: "SUBSCRIBED" | "CHANNEL_ERROR" | null;
} {
  const repository: WallieSessionData["repository"] = {
    defaultBranch: "anant/op-359-make-wallie-progress-and-run-activity-understandable-at-a",
    defaultProgrammingLanguage: "TypeScript",
    fullName: "acme/wallie",
    htmlUrl: "https://github.com/acme/wallie",
    id: "repository-1",
    isArchived: false,
    isPrivate: true,
  };

  const connection = {
    connected: true,
    lastValidationError: null,
    projectId: "prj_fixture",
    projectName: "wallie-dev",
    status: "connected" as const,
    teamId: "team_fixture",
  };

  const base: WallieSessionData = {
    blockingReasons: [],
    canEnqueue: true,
    loadedMessageRunIds: [],
    missingSecretKeys: [],
    mode: "code",
    nextRunCursor: null,
    repository,
    requiredSecretKeys: [],
    requiresVercelSandbox: false,
    runs: [],
    // Keep non-stalled fixtures immune to wall-clock drift after the live ticker starts.
    stallTimeoutMs: 365 * 24 * 60 * 60 * 1000,
    vercelSandboxConnection: connection,
    workspaceMembers: [],
  };

  switch (state) {
    case "active":
      return {
        data: {
          ...base,
          loadedMessageRunIds: ["run-active"],
          runs: [baseRun({ canCancel: true }), olderCompletedRun()],
        },
        delayMessagesMs: null,
        realtimeStatus: "SUBSCRIBED",
      };
    case "stalled":
      return {
        data: {
          ...base,
          loadedMessageRunIds: ["run-active"],
          runs: [
            baseRun({
              canCancel: true,
              lastActivityAt: "2026-07-18T17:30:00.000Z",
              messages: [
                {
                  createdAt: "2026-07-18T17:30:00.000Z",
                  id: "msg-stalled",
                  kind: "progress",
                  messageMd: "Waiting on sandbox boot",
                },
              ],
              updatedAt: "2026-07-18T17:30:00.000Z",
            }),
            olderCompletedRun(),
          ],
          stallTimeoutMs: 60_000,
        },
        delayMessagesMs: null,
        realtimeStatus: "SUBSCRIBED",
      };
    case "disconnected":
      return {
        data: {
          ...base,
          loadedMessageRunIds: ["run-active"],
          runs: [baseRun({ canCancel: true }), olderCompletedRun()],
        },
        delayMessagesMs: null,
        realtimeStatus: "CHANNEL_ERROR",
      };
    case "failed":
      return {
        data: {
          ...base,
          loadedMessageRunIds: ["run-failed"],
          runs: [
            baseRun({
              attemptCount: 2,
              canRetry: true,
              finishedAt: "2026-07-18T17:50:00.000Z",
              id: "run-failed",
              isActive: false,
              isTerminal: true,
              lastActivityAt: "2026-07-18T17:50:00.000Z",
              messages: [
                {
                  createdAt: "2026-07-18T17:50:00.000Z",
                  id: "msg-error",
                  kind: "error",
                  messageMd: "Sandbox exited with code 1 while installing dependencies.",
                },
              ],
              status: "error",
              updatedAt: "2026-07-18T17:50:00.000Z",
            }),
            olderCompletedRun(),
          ],
        },
        delayMessagesMs: null,
        realtimeStatus: "SUBSCRIBED",
      };
    case "queued":
      return {
        data: {
          ...base,
          loadedMessageRunIds: ["run-queued"],
          runs: [
            baseRun({
              canCancel: true,
              finishedAt: null,
              id: "run-queued",
              isActive: true,
              isTerminal: false,
              lastActivityAt: "2026-07-18T17:59:00.000Z",
              messages: [],
              startedAt: null,
              status: "queued",
              updatedAt: "2026-07-18T17:59:00.000Z",
            }),
          ],
        },
        delayMessagesMs: null,
        realtimeStatus: "SUBSCRIBED",
      };
    case "loading":
      return {
        data: {
          ...base,
          loadedMessageRunIds: [],
          runs: [
            baseRun({
              canRetry: true,
              finishedAt: "2026-07-18T17:50:00.000Z",
              id: "run-loading",
              isActive: false,
              isTerminal: true,
              messages: [],
              status: "success",
            }),
          ],
        },
        delayMessagesMs: 60_000,
        realtimeStatus: "SUBSCRIBED",
      };
    case "empty":
      return {
        data: {
          ...base,
          loadedMessageRunIds: ["run-empty"],
          runs: [
            baseRun({
              finishedAt: "2026-07-18T17:50:00.000Z",
              id: "run-empty",
              isActive: false,
              isTerminal: true,
              messages: [],
              status: "canceled",
            }),
          ],
        },
        delayMessagesMs: null,
        realtimeStatus: "SUBSCRIBED",
      };
    case "completed":
      return {
        data: {
          ...base,
          loadedMessageRunIds: ["run-done", "run-older"],
          runs: [
            baseRun({
              finishedAt: "2026-07-18T17:59:00.000Z",
              id: "run-done",
              isActive: false,
              isTerminal: true,
              lastActivityAt: "2026-07-18T17:59:00.000Z",
              messages: [
                {
                  createdAt: "2026-07-18T17:59:00.000Z",
                  id: "msg-done",
                  kind: "completion",
                  messageMd: "Build artifact ready for review.",
                },
              ],
              status: "success",
              updatedAt: "2026-07-18T17:59:00.000Z",
            }),
            olderCompletedRun(),
          ],
        },
        delayMessagesMs: null,
        realtimeStatus: "SUBSCRIBED",
      };
  }
}

function createFixtureSupabase(options: {
  delayMessagesMs: number | null;
  messagesByRunId: Record<string, Array<Record<string, string>>>;
  realtimeStatus: "SUBSCRIBED" | "CHANNEL_ERROR" | null;
}) {
  class FakeChannel {
    constructor(readonly name: string) {}

    on() {
      return this;
    }

    subscribe(callback?: (status: string) => void) {
      if (options.realtimeStatus && callback) {
        queueMicrotask(() => callback(options.realtimeStatus!));
      }
      return this;
    }
  }

  return {
    channel: (name: string) => new FakeChannel(name),
    from: () => ({
      select: () => ({
        eq: (_column: string, runId: string) => ({
          order: () => ({
            limit: async () => {
              if (options.delayMessagesMs !== null) {
                await new Promise((resolve) => {
                  window.setTimeout(resolve, options.delayMessagesMs!);
                });
              }
              return { data: options.messagesByRunId[runId] ?? [], error: null };
            },
          }),
        }),
      }),
    }),
    removeChannel: async () => "ok",
  } as unknown as SupabaseClient<Database>;
}

export function WallieActivityFixture({
  initialTheme = "light",
  state = "active",
}: {
  initialTheme?: "dark" | "light";
  state?: WallieActivityFixtureState;
}) {
  const { data, delayMessagesMs, realtimeStatus } = useMemo(() => buildData(state), [state]);
  const messagesByRunId = useMemo(() => {
    const index: Record<string, Array<Record<string, string>>> = {};
    for (const run of data.runs) {
      index[run.id] = run.messages.map((message) => ({
        agent_run_id: run.id,
        created_at: message.createdAt,
        id: message.id,
        kind: message.kind,
        message_md: message.messageMd,
      }));
    }
    return index;
  }, [data.runs]);

  const supabase = useMemo(
    () =>
      createFixtureSupabase({
        delayMessagesMs,
        messagesByRunId,
        realtimeStatus,
      }),
    [delayMessagesMs, messagesByRunId, realtimeStatus],
  );

  return (
    <div
      className={cn("min-h-screen bg-canvas text-foreground", initialTheme === "dark" && "dark")}
      data-theme={initialTheme}
      data-wallie-activity-fixture={state}
    >
      <div className="mx-auto w-full max-w-[42rem] px-4 py-8 sm:px-6">
        <header className="mb-6 space-y-1 border-b border-border pb-4">
          <p className="ui-label">Review Workbench · Activity</p>
          <h1 className="text-lg font-semibold text-foreground">Wallie activity fixture</h1>
          <p className="text-sm text-muted">State: {state}</p>
        </header>
        <SessionWalliePanel
          initialData={data}
          initialNow={FIXED_NOW}
          session={{
            archivedAt: null,
            id: SESSION_ID,
            workspaceId: WORKSPACE_ID,
          }}
          supabase={supabase}
          workspaceSlug="acme"
        />
      </div>
    </div>
  );
}
