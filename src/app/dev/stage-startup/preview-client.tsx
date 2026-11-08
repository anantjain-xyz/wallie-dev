"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import type { SessionReviewData } from "@/features/sessions/detail/data";
import { SessionDetailPageClient } from "@/features/sessions/detail/session-detail-page-client";
import { usePublishExecution } from "@/features/sessions/detail/execution-summary";
import type { WallieRun } from "@/features/wallie/types";

const now = "2026-11-08T12:00:00.000Z";
const scenarios = [
  "loading",
  "queued",
  "started",
  "running",
  "success",
  "error",
  "canceled",
] as const;
type Scenario = (typeof scenarios)[number];
const actions: Array<[Scenario, string]> = [
  ["loading", "Delay activity loading"],
  ["queued", "Queue Plan rerun"],
  ["started", "Worker pickup"],
  ["running", "Start agent"],
  ["success", "Ready for review"],
  ["error", "Fail run"],
  ["canceled", "Stop run"],
];

function fixtureRun(scenario: Scenario, revision: number): WallieRun {
  return {
    id: "proof-rerun",
    stageId: "plan",
    stageSlug: "plan",
    stageName: "Plan",
    status: scenario === "loading" ? "queued" : scenario,
    createdAt: now,
    updatedAt: new Date(Date.parse(now) + revision * 1000).toISOString(),
    startedAt: ["loading", "queued"].includes(scenario) ? null : now,
    finishedAt: ["success", "error", "canceled"].includes(scenario) ? now : null,
    isActive: ["loading", "queued", "started", "running"].includes(scenario),
    isTerminal: ["success", "error", "canceled"].includes(scenario),
    attemptCount: 2,
    branchName: null,
    canCancel: false,
    canRetry: false,
    lastActivityAt: now,
    messages: [],
    modelName: "Fixture",
    modelProvider: "Fixture",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "code",
    sandboxId: null,
    sandboxProvider: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalCostUsd: null,
      tokenProvenance: "unavailable",
      costProvenance: "unavailable",
      finalized: false,
    },
  };
}

function Activity({ run, loading }: { run: WallieRun; loading: boolean }) {
  usePublishExecution({
    sessionId: "stage-startup-proof",
    run: loading ? undefined : run,
    connection: "live",
    nowMs: Date.parse(now),
    stallTimeoutMs: 60000,
  });
  return (
    <section className="ui-sheet p-5">
      <h2 id="session-runs-heading">Plan run</h2>
      <p>{loading ? "Loading run history…" : `Run status: ${run.status}`}</p>
      <p className="mt-2 text-sm text-muted">
        Controlled fixture; no jobs or workspace data are changed.
      </p>
    </section>
  );
}

/** Real detail-page rendering with independently controlled history and session updates. */
export function StageStartupPreview() {
  const params = useSearchParams();
  const input = params.get("state");
  const initial = scenarios.find((value) => value === input) ?? "canceled";
  const [state, setState] = useState({ scenario: initial, revision: 0 });
  const initialRun = useMemo(() => fixtureRun(initial, 0), [initial]);
  const run = useMemo(() => fixtureRun(state.scenario, state.revision), [state]);
  const data = useMemo<SessionReviewData>(
    () => ({
      creatorDisplayName: null,
      workspaceSlug: "proof",
      session: {
        id: "stage-startup-proof",
        number: 1,
        title: "Better icon for session stage",
        promptMd: "Keep the numbered stage marker visible while Plan starts.",
        archivedAt: null,
        attachments: [],
        artifacts: [],
        phaseCompletions: [],
        pullRequests: [],
        currentStageId: "plan",
        currentStageSlug: "plan",
        currentArtifactVersion: 0,
        phaseStatus: state.scenario === "success" ? "awaiting_review" : "rejected",
        createdAt: now,
        updatedAt: run.updatedAt,
        linearIssueId: null,
        linearIssueUrl: null,
        pipeline: {
          stages: [
            { id: "plan", slug: "plan", name: "Plan", description: "Plan", position: 0 },
            { id: "build", slug: "build", name: "Build", description: "Build", position: 1 },
          ],
        },
      },
    }),
    [run.updatedAt, state.scenario],
  );
  if (params.get("open") !== "1")
    return (
      <main className="mx-auto max-w-4xl p-5">
        <h1 className="text-2xl font-semibold">Workspace session fixture</h1>
        <Link className="ui-button mt-5" href="/dev/stage-startup?open=1">
          Open session 1
        </Link>
      </main>
    );
  return (
    <>
      <aside
        aria-label="Fixture controls"
        className="mx-auto flex max-w-6xl flex-wrap gap-2 px-5 pt-5"
      >
        {actions.map(([scenario, label]) => (
          <button
            key={scenario}
            className="ui-button"
            onClick={() => setState((current) => ({ scenario, revision: current.revision + 1 }))}
          >
            {label}
          </button>
        ))}
      </aside>
      <SessionDetailPageClient
        activity={<Activity run={run} loading={state.scenario === "loading"} />}
        initialData={data}
        latestRun={initialRun}
        initialNow={now}
        initialFormattedArtifact={null}
        initialFormattedArtifactKey={null}
      />
    </>
  );
}
