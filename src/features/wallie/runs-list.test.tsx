// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import { RunsList } from "@/features/wallie/runs-list";
import {
  parseRunsListQuery,
  runCatalogActivityLabel,
  runCatalogCostLabel,
  runsListPageHref,
} from "@/features/wallie/runs-list-state";

const mocked = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocked }));

const SESSION_ID = "b0000000-0000-4000-8000-000000000001";
const STAGE_ID = "c0000000-0000-4000-8000-000000000001";
const RUN_ID = "d0000000-0000-4000-8000-000000000001";
const now = "2026-11-14T21:00:00.000Z";
const run: WorkspaceRunCatalogItem = {
  id: RUN_ID,
  sessionId: SESSION_ID,
  sessionNumber: 42,
  sessionTitle: "Improve sign-in reliability",
  sessionRunHref: `/w/acme/sessions/42#wallie-run-${RUN_ID}`,
  attemptCount: 2,
  stageId: STAGE_ID,
  stageName: "Build",
  modelProvider: "codex",
  modelName: "gpt-5.6",
  status: "success",
  interrupted: false,
  failure: null,
  createdAt: "2026-11-14T20:55:00.000Z",
  startedAt: "2026-11-14T20:55:00.000Z",
  finishedAt: "2026-11-14T20:58:00.000Z",
  lastActivityAt: "2026-11-14T20:58:00.000Z",
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
  recovery: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Runs list", () => {
  it("links distinct attempts to inspectors and keeps the session activity link", () => {
    const earlier = {
      ...run,
      id: "d0000000-0000-4000-8000-000000000002",
      attemptCount: 1,
      status: "error" as const,
    };
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceSlug: "acme",
          query: {},
          state: { kind: "ready", page: { runs: [run, earlier], nextCursor: null } },
        }}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: "Inspect run for session 42, Build, attempt 2" })
        .getAttribute("href"),
    ).toBe(`/w/acme/runs/${RUN_ID}`);
    expect(
      screen
        .getByRole("link", { name: "Inspect run for session 42, Build, attempt 1" })
        .getAttribute("href"),
    ).toBe(`/w/acme/runs/${earlier.id}`);
    expect(screen.getAllByRole("link", { name: "#42" })[0]?.getAttribute("href")).toBe(
      run.sessionRunHref,
    );
    expect(screen.getByText("2 runs on this page")).toBeTruthy();
    expect(screen.getAllByText("Cost unavailable")).toHaveLength(2);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("preserves filters in older/latest links and pushes a new filtered page without its old cursor", () => {
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceSlug: "acme",
          query: {
            cursor: "previous",
            status: "error",
            provider: "codex",
            sessionId: SESSION_ID,
            stageId: STAGE_ID,
          },
          state: { kind: "ready", page: { runs: [run], nextCursor: "next_page" } },
        }}
      />,
    );
    const older = new URL(
      screen.getByRole("link", { name: "Older runs →" }).getAttribute("href") ?? "",
      "http://localhost",
    );
    expect(Object.fromEntries(older.searchParams)).toEqual({
      cursor: "next_page",
      status: "error",
      provider: "codex",
      sessionId: SESSION_ID,
      stageId: STAGE_ID,
    });
    const latest = screen.getByRole("link", { name: "Back to latest" }).getAttribute("href");
    expect(latest).toContain("status=error");
    expect(latest).not.toContain("cursor=");

    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "canceled" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Filter runs" }));
    expect(mocked.push).toHaveBeenCalledTimes(1);
    const destination = new URL(mocked.push.mock.calls[0]?.[0], "http://localhost");
    expect(Object.fromEntries(destination.searchParams)).toEqual({
      status: "canceled",
      provider: "codex",
      sessionId: SESSION_ID,
      stageId: STAGE_ID,
    });
    expect(screen.getByRole("link", { name: "Clear" }).getAttribute("href")).toBe("/w/acme/runs");
  });

  it("keeps active session/stage filters even when no rows are available", () => {
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceSlug: "acme",
          query: { sessionId: SESSION_ID, stageId: STAGE_ID },
          state: { kind: "ready", page: { runs: [], nextCursor: null } },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "No matching runs" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Selected session" }).getAttribute("value")).toBe(
      SESSION_ID,
    );
    fireEvent.submit(screen.getByRole("form", { name: "Filter runs" }));
    expect(mocked.push).toHaveBeenCalledWith(
      `/w/acme/runs?sessionId=${SESSION_ID}&stageId=${STAGE_ID}`,
    );
  });

  it("shows a useful first-run empty state and a sessions return", () => {
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceSlug: "acme",
          query: {},
          state: { kind: "ready", page: { runs: [], nextCursor: null } },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "No runs yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View sessions" }).getAttribute("href")).toBe(
      "/w/acme/sessions",
    );
  });

  it("offers a safe restart for an invalid cursor without silently dropping filters", () => {
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceSlug: "acme",
          query: { cursor: "invalid", status: "error" },
          state: { kind: "invalid-cursor" },
        }}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Latest runs" }).getAttribute("href")).toBe(
      "/w/acme/runs?status=error",
    );
  });

  it("refreshes failed reads and does not present an error as an empty catalog", () => {
    render(
      <RunsList
        initialNow={now}
        data={{ workspaceSlug: "acme", query: {}, state: { kind: "error" } }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Runs couldn’t load" })).toBeTruthy();
    expect(screen.queryByText("No runs yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocked.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("Runs list state", () => {
  it("accepts blank GET form fields but rejects malformed or repeated filters", () => {
    expect(parseRunsListQuery({ provider: "", status: "error", limit: "20" })).toMatchObject({
      success: true,
      data: { status: "error", limit: 20 },
    });
    expect(parseRunsListQuery({ status: ["error", "success"] }).success).toBe(false);
    expect(parseRunsListQuery({ sessionId: "not-a-session" }).success).toBe(false);
    expect(parseRunsListQuery({ limit: "1000" }).success).toBe(false);
  });

  it("keeps opaque cursors unchanged across navigable URLs", () => {
    const cursor = "abc_def-123";
    expect(runsListPageHref("acme", { provider: "cursor", limit: 20 }, cursor)).toBe(
      `/w/acme/runs?provider=cursor&limit=20&cursor=${cursor}`,
    );
  });

  it("never presents legacy or interrupted activity as complete structured capture", () => {
    expect(
      runCatalogActivityLabel({ ...run, transcript: { ...run.transcript, hasEvents: false } }),
    ).toBe("Legacy activity");
    expect(
      runCatalogActivityLabel({ ...run, transcript: { ...run.transcript, captureEnded: false } }),
    ).toBe("Capture incomplete");
    expect(
      runCatalogActivityLabel({
        ...run,
        transcript: { ...run.transcript, captureInterrupted: true },
      }),
    ).toBe("Capture interrupted");
    expect(
      runCatalogActivityLabel({
        ...run,
        status: "running",
        transcript: { ...run.transcript, captureEnded: false },
      }),
    ).toBe("Structured activity");
  });

  it("distinguishes measured zero, estimates and unavailable cost", () => {
    expect(runCatalogCostLabel(run)).toBe("Cost unavailable");
    expect(
      runCatalogCostLabel({
        ...run,
        usage: { ...run.usage, totalCostUsd: 0, costProvenance: "measured" },
      }),
    ).toBe("$0.00 measured");
    expect(
      runCatalogCostLabel({
        ...run,
        usage: { ...run.usage, totalCostUsd: 0.25, costProvenance: "estimated" },
      }),
    ).toBe("$0.25 estimated");
  });
});
