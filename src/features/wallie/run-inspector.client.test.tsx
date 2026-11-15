// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import type { RunCatalogRecovery } from "@/features/wallie/run-catalog-recovery";
import { RunInspector } from "@/features/wallie/run-inspector";
import type { RunInspectorArtifact } from "@/features/wallie/run-inspector-data";
import { parseRunFailure } from "@/lib/pipeline/run-failure";

const now = "2026-11-14T20:00:00.000Z";
const recovery: RunCatalogRecovery = {
  metadataAvailable: true,
  queue: { state: "current", status: "success", attemptCount: 4, scheduledAt: null },
  publication: null,
  sourceRecoveryRequired: false,
  retryCheckpointAvailable: false,
  activity: { state: "unknown", observedAt: now, thresholdMs: 900_000 },
  worker: { state: "unobserved", deadlineAt: null, dispatchedAt: null, executionStartedAt: null },
};
const run: WorkspaceRunCatalogItem = {
  id: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  sessionNumber: 42,
  sessionTitle: "Build workspace run inspector",
  sessionRunHref: "/w/wallie/sessions/42#wallie-run-00000000-0000-4000-8000-000000000002",
  attemptCount: 4,
  stageId: "00000000-0000-4000-8000-000000000004",
  stageName: "Build",
  modelProvider: "codex",
  modelName: "gpt-5",
  status: "success",
  interrupted: false,
  failure: null,
  createdAt: now,
  startedAt: now,
  finishedAt: now,
  lastActivityAt: now,
  usage: {
    inputTokens: null,
    outputTokens: null,
    totalCostUsd: null,
    tokenProvenance: "unavailable",
    costProvenance: "unavailable",
    finalized: true,
  },
  transcript: {
    hasEvents: true,
    hasLegacyMessages: true,
    captureEnded: true,
    captureInterrupted: false,
  },
  recovery,
};

function show(
  changes: Partial<WorkspaceRunCatalogItem> = {},
  artifact: RunInspectorArtifact = { kind: "none" },
) {
  return render(
    <RunInspector
      artifact={artifact}
      initialNow={now}
      run={{ ...run, ...changes }}
      workspaceSlug="wallie"
      transcript={<p>Exact attempt activity</p>}
    />,
  );
}

afterEach(cleanup);

describe("RunInspector", () => {
  it("shows the durable attempt, source session and exact accepted artifact link", () => {
    show(
      {},
      {
        kind: "available",
        id: "artifact",
        stageSlug: "build",
        version: 2,
        createdAt: now,
        href: "/w/wallie/sessions/42?artifactStage=build&artifactVersion=2",
      },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(run.sessionTitle);
    expect(screen.getByText("Build · Attempt 4")).toBeTruthy();
    expect(screen.getByText(run.id)).toBeTruthy();
    expect(screen.getByRole("link", { name: "← Runs" }).getAttribute("href")).toBe(
      "/w/wallie/runs",
    );
    expect(
      screen.getByRole("link", { name: `#42 · ${run.sessionTitle}` }).getAttribute("href"),
    ).toBe(run.sessionRunHref);
    expect(screen.getByRole("link", { name: "Open artifact" }).getAttribute("href")).toBe(
      "/w/wallie/sessions/42?artifactStage=build&artifactVersion=2",
    );
    expect(screen.getByText("Exact attempt activity")).toBeTruthy();
    expect(screen.getByText("Cost unavailable")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("keeps cancellation visible even when a newer attempt exists", () => {
    show({
      status: "canceled",
      recovery: {
        ...recovery,
        queue: { state: "superseded", status: "running", attemptCount: 5, scheduledAt: now },
      },
    });
    expect(screen.getByLabelText("Canceled. Work was canceled.")).toBeTruthy();
    expect(screen.getByText("This attempt was canceled.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "A newer attempt exists" })).toBeTruthy();
    expect(screen.queryByLabelText("Running. Work is in progress.")).toBeNull();
  });

  it("shows safe failure cause and scheduled recovery without relabeling the failed attempt", () => {
    show({
      status: "error",
      failure: parseRunFailure('{"version":1,"code":"agent_exit","category":"agent_exit"}'),
      recovery: {
        ...recovery,
        queue: { state: "retry_scheduled", status: "queued", attemptCount: 4, scheduledAt: now },
      },
    });
    expect(screen.getByLabelText("Failed. Work stopped because of an error.")).toBeTruthy();
    expect(
      screen.getByText("The agent process exited unsuccessfully before completing the run."),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retry scheduled" })).toBeTruthy();
  });

  it("distinguishes pending publication from a retry", () => {
    show({
      status: "running",
      recovery: {
        ...recovery,
        publication: {
          status: "pending",
          deadlineAt: now,
          deadlineExpired: false,
          nextAttemptAt: now,
          attemptCount: 2,
          leaseExpiresAt: null,
        },
      },
    });
    expect(screen.getByRole("heading", { name: "Publishing saved output" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Review before retrying" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open artifact" })).toBeNull();
  });

  it("states the limits of stale activity without claiming a stopped worker", () => {
    show({
      status: "running",
      finishedAt: null,
      recovery: { ...recovery, activity: { ...recovery.activity, state: "stale" } },
    });
    expect(screen.getByRole("heading", { name: "No recent activity" })).toBeTruthy();
    expect(screen.getByText(/does not confirm that the worker stopped/)).toBeTruthy();
  });

  it("keeps legacy attempt and artifact uncertainty explicit", () => {
    show({ attemptCount: null, recovery: null }, { kind: "unrecorded" });
    expect(screen.getByText("Build · Attempt not recorded")).toBeTruthy();
    expect(screen.getByText("An exact artifact link was not recorded for this run.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recovery details unavailable" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open artifact" })).toBeNull();
  });

  it("labels estimated partial usage separately from unavailable usage", () => {
    show({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalCostUsd: 0,
        tokenProvenance: "estimated",
        costProvenance: "estimated",
        finalized: false,
      },
    });
    expect(screen.getByText("100 in · 50 out · estimated · Not final")).toBeTruthy();
    expect(screen.getByText("$0.00 estimated · Not final")).toBeTruthy();
  });
});
