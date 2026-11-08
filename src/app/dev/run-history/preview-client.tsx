"use client";

import { createClient, REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import type { SessionPhaseStatus } from "@/features/sessions/types";
import { SessionWalliePanel } from "@/features/wallie/session-wallie-panel";
import type { WallieRun, WallieSessionData } from "@/features/wallie/types";
import type { Database } from "@/lib/supabase/database.types";

const now = "2026-11-08T20:00:00.000Z";
const scenarios = [
  "completed",
  "awaiting-review",
  "failed",
  "canceled",
  "archived",
  "in-progress",
] as const;
type Scenario = (typeof scenarios)[number];

function fixtureRun(
  index: number,
  stage: "plan" | "build",
  status: WallieRun["status"],
): WallieRun {
  const createdAt = `2026-11-08T${String(18 - index).padStart(2, "0")}:00:00.000Z`;
  const active = status === "running" || status === "queued";
  return {
    id: `fixture-run-${index}`,
    stageId: stage,
    stageName: stage === "build" ? "Build" : "Plan",
    stageSlug: stage,
    attemptCount: stage === "build" ? 3 - index : 5 - index,
    status,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    finishedAt: active ? null : createdAt,
    lastActivityAt: active ? now : createdAt,
    isActive: active,
    isTerminal: !active,
    canRetry: status === "error" || status === "canceled",
    canCancel: active,
    branchName: null,
    messages: [],
    modelName: "gpt-5.5",
    modelProvider: "codex",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "project",
    sandboxId: null,
    sandboxProvider: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalCostUsd: null,
      tokenProvenance: "unavailable",
      costProvenance: "unavailable",
      finalized: !active,
    },
  };
}

function fixtureData(scenario: Scenario): WallieSessionData {
  const status =
    scenario === "failed"
      ? "error"
      : scenario === "canceled" || scenario === "archived"
        ? "canceled"
        : scenario === "in-progress"
          ? "running"
          : "success";
  const runs = [
    fixtureRun(0, "build", status),
    fixtureRun(1, "build", "canceled"),
    fixtureRun(2, "build", "error"),
    fixtureRun(3, "plan", "success"),
    fixtureRun(4, "plan", "error"),
  ];
  return {
    blockingReasons: [],
    canEnqueue: true,
    mode: "project",
    nextRunCursor: null,
    repository: null,
    requiresVercelSandbox: false,
    runs,
    loadedMessageRunIds: runs.map((run) => run.id),
    stallTimeoutMs: 86400000,
    workspaceMembers: [],
    vercelSandboxConnection: {
      connected: true,
      lastValidationError: null,
      projectId: null,
      projectName: null,
      status: "connected",
      teamId: null,
    },
  };
}

function fixtureClient() {
  const client = createClient<Database>("http://127.0.0.1:54321", "fixture-only", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => Response.json([]) },
  });
  client.auth.getSession = async () => ({
    data: {
      session: {
        access_token: "fixture-only",
        refresh_token: "fixture-only",
        expires_in: 3600,
        token_type: "bearer",
        user: {
          id: "fixture-member",
          aud: "authenticated",
          app_metadata: {},
          user_metadata: {},
          created_at: now,
        },
      },
    },
    error: null,
  });
  client.realtime.setAuth = async () => {};
  const createChannel = client.channel.bind(client);
  client.channel = (name, options) => {
    const channel = createChannel(name, options);
    channel.subscribe = (callback) => {
      queueMicrotask(() => callback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
      return channel;
    };
    return channel;
  };
  client.removeChannel = async () => "ok";
  return client;
}

export function RunHistoryPreview() {
  const [scenario, setScenario] = useState<Scenario>("completed");
  const [result, setResult] = useState("success");
  const [ready, setReady] = useState(false);
  const [requests, setRequests] = useState(0);
  const [data, setData] = useState(() => fixtureData("completed"));
  const client = useMemo(() => fixtureClient(), []);
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/sessions/fixture-session-"))
        return Response.json({ runs: data.runs, nextCursor: null });
      const cancelSource = data.runs.find((run) => url === `/api/agent-runs/${run.id}/cancel`);
      if (cancelSource && init?.method === "POST") {
        const canceledRun: WallieRun = {
          ...cancelSource,
          status: "canceled",
          isActive: false,
          isTerminal: true,
          canRetry: true,
          canCancel: false,
          finishedAt: now,
          updatedAt: now,
        };
        setData((current) => ({
          ...current,
          runs: current.runs.map((run) => (run.id === canceledRun.id ? canceledRun : run)),
        }));
        return Response.json({ canceled: true, run: canceledRun });
      }
      if (
        data.runs.some((run) => url === `/api/agent-runs/${run.id}/retry`) &&
        init?.method === "POST"
      ) {
        setRequests((value) => value + 1);
        if (result === "loading") return new Promise<Response>(() => {});
        if (result === "error")
          return Response.json(
            { error: "This session is complete. There is nothing left to run." },
            { status: 409 },
          );
        return Response.json({
          created: true,
          processScheduled: true,
          run: {
            ...fixtureRun(0, "build", "queued"),
            id: "fixture-run-new",
            createdAt: now,
            attemptCount: 4,
          },
        });
      }
      return original(input, init);
    };
    const readyTimer = window.setTimeout(() => setReady(true), 0);
    return () => {
      window.clearTimeout(readyTimer);
      window.fetch = original;
    };
  }, [data, result]);
  const phaseStatus: SessionPhaseStatus =
    scenario === "completed"
      ? "approved"
      : scenario === "awaiting-review"
        ? "awaiting_review"
        : scenario === "in-progress" && data.runs.some((run) => run.isActive)
          ? "in_progress"
          : "rejected";
  return (
    <main id="main-content" className="mx-auto max-w-4xl space-y-6 p-5 sm:p-10">
      <div>
        <h1 className="text-2xl font-semibold">Run history preview</h1>
        <p className="mt-2 text-sm text-muted">
          Local fixtures. Retry and stop requests are mocked and create no work.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-sm">
          Session state
          <select
            className="ui-input"
            value={scenario}
            onChange={(event) => {
              const next = scenarios.find((value) => value === event.target.value);
              if (next) {
                setScenario(next);
                setData(fixtureData(next));
                setRequests(0);
              }
            }}
          >
            {scenarios.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Retry response
          <select
            className="ui-input"
            value={result}
            onChange={(event) => setResult(event.target.value)}
          >
            <option>success</option>
            <option>loading</option>
            <option>error</option>
          </select>
        </label>
      </div>
      <p className="text-sm text-muted" role="status">
        Mock retry requests: {requests}
      </p>
      <h2 className="text-lg font-semibold">
        {scenario === "completed"
          ? "Session complete"
          : scenario === "awaiting-review"
            ? "Build ready for review"
            : scenario === "in-progress" && data.runs.some((run) => run.isActive)
              ? "Build in progress"
              : scenario === "in-progress"
                ? "Build canceled"
                : scenario === "archived"
                  ? "Session archived"
                  : `Build ${scenario}`}
      </h2>
      {ready ? (
        <SessionWalliePanel
          key={scenario}
          initialData={data}
          initialNow={now}
          presentation={{
            currentStage: { id: "build", name: "Build", phaseStatus },
            stopControl: undefined,
          }}
          session={{
            archivedAt: scenario === "archived" ? now : null,
            id: `fixture-session-${scenario}`,
            workspaceId: "fixture-workspace",
          }}
          supabase={client}
          workspaceSlug="fixture"
        />
      ) : null}
    </main>
  );
}
