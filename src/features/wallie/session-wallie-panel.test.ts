import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RECOMMENDED_AGENT_CONFIG_DEFAULTS } from "@/lib/agent-config/contracts";
import { WallieRunCard } from "@/features/wallie/run-activity";
import { SessionWalliePanel } from "@/features/wallie/session-wallie-panel";
import type { WallieRun, WallieSessionData } from "@/features/wallie/types";
import type { WorkspaceMember } from "@/features/workspace-members/types";
import type { Database } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

const baseMember: WorkspaceMember = {
  avatarUrl: null,
  fullName: "Anant Jain",
  id: "mem-reviewer",
  isActive: true,
  kind: "human",
  role: "owner",
  userId: "user-1",
  username: "anant",
};

function run(overrides: Partial<WallieRun> = {}): WallieRun {
  return {
    attemptCount: 1,
    canCancel: false,
    canRetry: false,
    createdAt: "2026-05-20T20:00:00.000Z",
    finishedAt: "2026-05-20T20:05:00.000Z",
    id: "run-1",
    isActive: false,
    isTerminal: true,
    lastActivityAt: "2026-05-20T20:05:00.000Z",
    messages: [
      {
        createdAt: "2026-05-20T20:05:00.000Z",
        id: "msg-1",
        kind: "completion",
        messageMd: "Product spec created.",
      },
    ],
    modelName: "gpt-5.5",
    modelProvider: "codex",
    requestedByMember: baseMember,
    requestedByMemberId: baseMember.id,
    runType: "code",
    sandboxId: null,
    sandboxProvider: null,
    stageId: "stage-product",
    stageName: "Product",
    stageSlug: "product",
    startedAt: "2026-05-20T20:01:00.000Z",
    status: "success",
    updatedAt: "2026-05-20T20:05:00.000Z",
    ...overrides,
  };
}

function data(overrides: Partial<WallieSessionData> = {}): WallieSessionData {
  const runs = overrides.runs ?? [run()];
  return {
    blockingReasons: [],
    canEnqueue: true,
    mode: "code",
    repository: {
      defaultBranch: "main",
      defaultProgrammingLanguage: "TypeScript",
      fullName: "anantjain-xyz/wallie-dev",
      htmlUrl: "https://github.com/anantjain-xyz/wallie-dev",
      id: "repo-1",
      isArchived: false,
      isPrivate: true,
    },
    requiresVercelSandbox: true,
    runs,
    stallTimeoutMs: RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms,
    vercelSandboxConnection: {
      connected: true,
      lastValidationError: null,
      projectId: "prj_123",
      projectName: "wallie-sandboxes",
      status: "connected",
      teamId: "team_123",
    },
    workspaceMembers: [baseMember],
    ...overrides,
    loadedMessageRunIds: overrides.loadedMessageRunIds ?? runs.map((entry) => entry.id),
    nextRunCursor: overrides.nextRunCursor ?? null,
  };
}

function renderPanel(initialData: WallieSessionData, archivedAt: string | null = null) {
  return renderToStaticMarkup(
    createElement(SessionWalliePanel, {
      initialData,
      initialNow: "2026-05-20T20:10:00.000Z",
      session: { archivedAt, id: "sess-1", workspaceId: "ws-1" },
      supabase: {} as SupabaseClient<Database>,
      workspaceSlug: "acme",
    }),
  );
}

function renderExpandedCard(initialData: WallieSessionData) {
  return renderToStaticMarkup(
    createElement(WallieRunCard, {
      actionPending: false,
      branchName: null,
      cancelLocked: false,
      connectionState: "live",
      isExpanded: true,
      isPrimary: true,
      messagesLoaded: initialData.loadedMessageRunIds.includes(initialData.runs[0].id),
      messagesLoadFailed: false,
      nowMs: Date.parse("2026-05-20T20:10:00.000Z"),
      onCancel: async () => {},
      onRetry: async () => {},
      onToggle: () => {},
      renderNow: "2026-05-20T20:10:00.000Z",
      retryLocked: false,
      run: initialData.runs[0],
      stallTimeoutMs: initialData.stallTimeoutMs,
    }),
  );
}

describe("SessionWalliePanel", () => {
  it("uses stage/requester labels and hides internal execution controls", () => {
    const html = renderPanel(data());

    expect(html).toContain("Product run");
    expect(html).not.toContain("Requested by Anant Jain");
    expect(renderExpandedCard(data())).toContain("Requested by Anant Jain");
    expect(html).not.toContain("Code mode");
    expect(html).not.toContain("Run With Wallie");
    expect(html).not.toContain("Required:");
    expect(html).not.toContain("Retry Run");
    expect(html).not.toContain("Unknown member");
    expect(html).not.toContain("Codex session completed");
  });

  it("marks every collapsed inactive row as a run history group", () => {
    const html = renderPanel(
      data({
        runs: [run(), run({ id: "run-2", stageName: "Build", stageSlug: "build" })],
      }),
    );

    // The primary run is distinct from the compact history rows.
    expect((html.match(/run-history-group/g) ?? []).length).toBe(1);
  });

  it("allows retry only when the run is retryable", () => {
    const html = renderPanel(data({ runs: [run({ canRetry: true, status: "error" })] }));

    expect(html).toContain("Retry Run");
  });

  it("disables retry and explains why when the session is archived", () => {
    const html = renderPanel(
      data({ runs: [run({ canRetry: true, status: "error" })] }),
      "2026-06-07T12:00:00.000Z",
    );

    expect(html).toContain("This session is archived. Unarchive it to run Wallie again.");
    // The Retry Run button still renders but must be disabled.
    expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*>\s*Retry Run\s*<\/button>/);
  });

  it("keeps setup problems out of archived history without enabling retry", () => {
    const html = renderPanel(
      data({ repository: null, runs: [run({ canRetry: true, status: "error" })] }),
      "2026-06-07T12:00:00.000Z",
    );
    expect(html).not.toContain("Setup needed before");
    expect(html).not.toContain("Open Workspace Settings");
    expect(html).toContain("This session is archived.");
    expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*>\s*Retry Run\s*<\/button>/);
  });

  it.each([
    ["successful history", [run()], false],
    ["active work", [run({ isActive: true, isTerminal: false, status: "running" })], false],
    ["retryable failure", [run({ canRetry: true, status: "error" })], true],
    ["first run", [], true],
  ] as const)("makes setup guidance actionable for %s", (_label, runs, expanded) => {
    const html = renderPanel(data({ repository: null, runs: [...runs] }));
    const details = html.match(/<details[^>]*>\s*<summary[^>]*>Setup needed before/);
    expect(details).not.toBeNull();
    expect(details![0].includes('open=""')).toBe(expanded);
    expect(html).toContain("Open Workspace Settings");
    if (runs[0]?.canRetry) {
      expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*>\s*Retry Run\s*<\/button>/);
    }
  });

  it("does not show the Vercel setup blocker when fake sandboxes are selected", () => {
    const html = renderPanel(
      data({
        requiresVercelSandbox: false,
        vercelSandboxConnection: {
          connected: false,
          lastValidationError: null,
          projectId: null,
          projectName: null,
          status: "missing",
          teamId: null,
        },
      }),
    );

    expect(html).not.toContain("Connect a Vercel Sandbox account");
  });

  it("shows one unified active-run card without a duplicate summary", () => {
    const html = renderPanel(
      data({
        runs: [
          run({
            attemptCount: 2,
            finishedAt: null,
            isActive: true,
            isTerminal: false,
            lastActivityAt: "2026-05-20T20:09:00.000Z",
            messages: [],
            status: "running",
          }),
        ],
      }),
    );

    expect(html).toContain("data-wallie-summary");
    expect(html).not.toContain("Current activity");
    expect((html.match(/data-run-id="run-1"/g) ?? []).length).toBe(1);
    expect((html.match(/>Product run</g) ?? []).length).toBe(1);
    expect(html).toContain("Working");
    expect(html).not.toContain("Connecting…");
    expect(html).toContain("Attempt 2");
    expect(html).toContain("activity-shimmer");
    expect(html).not.toContain("animate-spin");
  });

  it("places only older records under Run history", () => {
    const html = renderPanel(
      data({
        runs: [run(), run({ id: "run-2", stageName: "Build", stageSlug: "build" })],
      }),
    );

    expect(html).toContain("Run history");
    expect((html.match(/data-wallie-summary/g) ?? []).length).toBe(1);
    expect((html.match(/data-run-id=/g) ?? []).length).toBe(2);
    expect((html.match(/run-history-group/g) ?? []).length).toBe(1);
  });

  it("collapses all runs by default and does not mount their transcripts", () => {
    const html = renderPanel(
      data({
        runs: [
          run({
            id: "run-latest",
            messages: [
              {
                createdAt: "2026-05-20T20:05:00.000Z",
                id: "msg-latest",
                kind: "completion",
                messageMd: "Latest completion body",
              },
            ],
          }),
          run({
            id: "run-older",
            messages: [
              {
                createdAt: "2026-05-20T19:05:00.000Z",
                id: "msg-older",
                kind: "completion",
                messageMd: "Older completion body",
              },
            ],
          }),
        ],
        loadedMessageRunIds: ["run-latest", "run-older"],
      }),
    );

    expect(html).not.toContain("Latest completion body");
    expect(html).not.toContain("Older completion body");
    expect(html).not.toContain('aria-expanded="true"');
  });

  it("uses the typographic ellipsis for loading copy", () => {
    const html = renderExpandedCard(
      data({
        loadedMessageRunIds: [],
        runs: [run({ messages: [], status: "success" })],
      }),
    );

    expect(html).toContain("Loading run messages…");
    expect(html).not.toContain("Loading run messages...");
  });

  it("renders queued, failed, canceled, and completed status fixtures with shared grammar", () => {
    const fixtures: Array<{ status: WallieRun["status"]; label: string }> = [
      { status: "queued", label: "Waiting in queue" },
      { status: "error", label: "Failed" },
      { status: "canceled", label: "Canceled" },
      { status: "success", label: "Complete" },
    ];

    for (const fixture of fixtures) {
      const html = renderPanel(
        data({
          runs: [
            run({
              finishedAt: fixture.status === "queued" ? null : run().finishedAt,
              isActive: fixture.status === "queued",
              isTerminal: fixture.status !== "queued",
              status: fixture.status,
            }),
          ],
        }),
      );
      expect(html).toContain(fixture.label);
      expect(html).toContain(
        `data-status="${fixture.status === "error" ? "failed" : fixture.status === "success" ? "complete" : fixture.status === "queued" ? "queued" : "canceled"}"`,
      );
    }
  });

  it("surfaces stalled recovery copy at the workspace stall threshold", () => {
    const html = renderPanel(
      data({
        stallTimeoutMs: 60_000,
        runs: [
          run({
            canCancel: true,
            createdAt: "2026-05-20T20:00:00.000Z",
            finishedAt: null,
            isActive: true,
            isTerminal: false,
            lastActivityAt: "2026-05-20T20:00:00.000Z",
            messages: [],
            startedAt: "2026-05-20T20:00:00.000Z",
            status: "running",
          }),
        ],
      }),
    );

    expect(html).toContain("No recent activity");
    expect(html).toContain(">Stop run</button>");
    expect(html).toContain("This run may be stalled. Cancel it before retrying.");
    expect(html).not.toContain("Wallie is working…");
  });

  it("does not claim a stalled run has no messages when its timeline has activity", () => {
    const html = renderPanel(
      data({
        stallTimeoutMs: 60_000,
        runs: [
          run({
            canCancel: true,
            createdAt: "2026-05-20T20:00:00.000Z",
            finishedAt: null,
            isActive: true,
            isTerminal: false,
            lastActivityAt: "2026-05-20T20:00:00.000Z",
            messages: [
              {
                createdAt: "2026-05-20T20:00:30.000Z",
                id: "msg-progress",
                kind: "progress",
                messageMd: "Cloning repository",
              },
            ],
            startedAt: "2026-05-20T20:00:00.000Z",
            status: "running",
          }),
        ],
      }),
    );

    expect(html).toContain("Cloning repository");
    expect(html).toContain("No recent activity");
    expect(html).not.toContain("No messages recorded yet.");
  });

  it("keeps cached failures visible even in collapsed previous runs", () => {
    const html = renderPanel(
      data({
        runs: [
          run({ id: "run-latest", messages: [] }),
          run({
            canRetry: true,
            id: "run-error",
            messages: [
              {
                createdAt: "2026-05-20T20:05:00.000Z",
                id: "msg-error",
                kind: "error",
                messageMd: "**Error:** Vercel Sandbox credentials are required.",
              },
            ],
            status: "error",
          }),
        ],
      }),
    );

    expect(html).toContain("Vercel Sandbox credentials are required.");
  });

  it("falls back to a human-readable requester label when member names are blank", () => {
    const memberWithoutName = {
      ...baseMember,
      fullName: "",
      username: null,
    };

    const html = renderExpandedCard(
      data({
        runs: [
          run({
            requestedByMember: memberWithoutName,
            requestedByMemberId: memberWithoutName.id,
          }),
        ],
      }),
    );

    expect(html).toContain("Requested by workspace owner");
    expect(html).not.toContain("unavailable member");
  });

  it("keeps tool payloads out of the initial markup, including an expanded timeline", () => {
    const initialData = data({
      runs: [
        run({
          messages: [
            {
              id: "tool-1",
              kind: "tool_use",
              createdAt: "2026-05-20T20:05:00.000Z",
              messageMd:
                '**Tool:** bash\n\n```\n{"cmd":"pnpm check","internal":"large payload"}\n```',
            },
          ],
        }),
      ],
    });
    expect(renderPanel(initialData)).not.toContain("pnpm check");
    const expanded = renderExpandedCard(initialData);
    expect(expanded).toContain("Shell");
    expect(expanded).toContain("pnpm check");
    expect(expanded).not.toContain("large payload");
    expect(expanded).not.toContain("artifact-pre");
  });
});
