// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  executionStateLabel,
  SessionExecutionProvider,
  SessionExecutionSummary,
  usePublishExecution,
  usePublishExecutionUnavailable,
} from "./execution-summary";
import type { WallieRun } from "@/features/wallie/types";

const now = "2026-09-04T12:00:00Z";
const run: WallieRun = {
  attemptCount: 1,
  canCancel: true,
  canRetry: false,
  createdAt: now,
  finishedAt: null,
  id: "run",
  isActive: true,
  isTerminal: false,
  lastActivityAt: now,
  messages: [],
  modelName: "model",
  modelProvider: "provider",
  requestedByMember: null,
  requestedByMemberId: null,
  runType: "project",
  sandboxId: null,
  sandboxProvider: null,
  startedAt: null,
  stageId: "stage",
  stageName: "Custom stage",
  stageSlug: "custom",
  status: "queued",
  updatedAt: now,
};
const snapshot = { sessionId: "session", run, connection: "live" as const, stalled: false };
function Publisher({
  value = run,
  disconnected = false,
}: {
  value?: WallieRun;
  disconnected?: boolean;
}) {
  usePublishExecution({
    sessionId: "session",
    run: value,
    connection: disconnected ? "disconnected" : "live",
    nowMs: Date.parse(now),
    stallTimeoutMs: 60000,
  });
  return null;
}
function Unavailable() {
  usePublishExecutionUnavailable();
  return null;
}
const props = {
  sessionId: "session",
  stageId: "stage",
  stageName: "Custom stage",
  phaseStatus: "in_progress" as const,
  archivedAt: null,
  initialNow: now,
};
afterEach(cleanup);
describe("execution summary", () => {
  it("keeps authoritative review state separate from run and transport state", () => {
    expect(
      executionStateLabel("awaiting_review", { ...snapshot, connection: "disconnected" }, "stage"),
    ).toBe("Ready for your review");
    expect(executionStateLabel("in_progress", snapshot, "stage")).toBe("Queued");
    expect(executionStateLabel("in_progress", snapshot, "other-stage")).toBe("Waiting for a run");
    expect(
      executionStateLabel(
        "in_progress",
        { ...snapshot, run: { ...run, status: "success", isActive: false } },
        "stage",
      ),
    ).toBe("Waiting for the stage to update");
    expect(
      executionStateLabel(
        "in_progress",
        { ...snapshot, run: { ...run, status: "running" }, stalled: true },
        "stage",
      ),
    ).toBe("No recent activity");
  });
  it("updates from existing live history and preserves the last known state on disconnect", () => {
    const view = render(
      <SessionExecutionProvider>
        <Publisher />
        <SessionExecutionSummary {...props} />
      </SessionExecutionProvider>,
    );
    expect(screen.getByText("Custom stage · Queued")).toBeTruthy();
    expect(screen.getByText("The worker has not started this run yet.")).toBeTruthy();
    view.rerender(
      <SessionExecutionProvider>
        <Publisher value={{ ...run, status: "running" }} disconnected />
        <SessionExecutionSummary {...props} />
      </SessionExecutionProvider>,
    );
    expect(screen.getByText("Custom stage · Run in progress")).toBeTruthy();
    expect(screen.getByText(/Live updates are paused/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View run history" }).getAttribute("href")).toBe(
      "#session-runs-heading",
    );
  });
  it("replaces loading with a truthful error and recovers when history mounts", () => {
    const view = render(
      <SessionExecutionProvider>
        <Unavailable />
        <SessionExecutionSummary {...props} />
      </SessionExecutionProvider>,
    );
    expect(screen.getByText("Custom stage · Run status unavailable")).toBeTruthy();
    view.rerender(
      <SessionExecutionProvider>
        <Publisher />
        <SessionExecutionSummary {...props} />
      </SessionExecutionProvider>,
    );
    expect(screen.getByText("Custom stage · Queued")).toBeTruthy();
    view.rerender(
      <SessionExecutionProvider>
        <Publisher />
        <SessionExecutionSummary {...props} archivedAt={now} />
      </SessionExecutionProvider>,
    );
    expect(screen.queryByRole("region", { name: "Current execution" })).toBeNull();
  });
});
