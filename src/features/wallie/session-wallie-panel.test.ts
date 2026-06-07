import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
    canRetry: false,
    createdAt: "2026-05-20T20:00:00.000Z",
    finishedAt: "2026-05-20T20:05:00.000Z",
    id: "run-1",
    isActive: false,
    isTerminal: true,
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
    stageId: "stage-product",
    stageName: "Product",
    stageSlug: "product",
    startedAt: "2026-05-20T20:01:00.000Z",
    status: "success",
    ...overrides,
  };
}

function data(overrides: Partial<WallieSessionData> = {}): WallieSessionData {
  return {
    blockingReasons: [],
    canEnqueue: true,
    missingSecretKeys: [],
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
    requiredSecretKeys: [],
    runs: [run()],
    vercelSandboxConnection: {
      connected: true,
      lastValidationError: null,
      projectId: "prj_123",
      projectName: "wallie-sandboxes",
      status: "connected",
      teamId: "team_123",
    },
    ...overrides,
  };
}

describe("SessionWalliePanel", () => {
  it("uses stage/requester labels and hides internal execution controls", () => {
    const html = renderToStaticMarkup(
      createElement(SessionWalliePanel, {
        initialData: data(),
        memberIndex: new Map([[baseMember.id, baseMember]]),
        session: { id: "sess-1", workspaceId: "ws-1" },
        supabase: {} as SupabaseClient<Database>,
        workspaceSlug: "acme",
      }),
    );

    expect(html).toContain("Product run");
    expect(html).toContain("Requested by Anant Jain");
    expect(html).not.toContain("Code mode");
    expect(html).not.toContain("Run With Wallie");
    expect(html).not.toContain("Required:");
    expect(html).not.toContain("Retry Run");
    expect(html).not.toContain("Unknown member");
    expect(html).not.toContain("Codex session completed");
  });

  it("allows retry only when the run is retryable", () => {
    const html = renderToStaticMarkup(
      createElement(SessionWalliePanel, {
        initialData: data({ runs: [run({ canRetry: true, status: "error" })] }),
        memberIndex: new Map([[baseMember.id, baseMember]]),
        session: { id: "sess-1", workspaceId: "ws-1" },
        supabase: {} as SupabaseClient<Database>,
        workspaceSlug: "acme",
      }),
    );

    expect(html).toContain("Retry Run");
  });

  it("does not show the Vercel setup blocker when fake sandboxes are selected", () => {
    const html = renderToStaticMarkup(
      createElement(SessionWalliePanel, {
        initialData: data({
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
        memberIndex: new Map([[baseMember.id, baseMember]]),
        session: { id: "sess-1", workspaceId: "ws-1" },
        supabase: {} as SupabaseClient<Database>,
        workspaceSlug: "acme",
      }),
    );

    expect(html).not.toContain("Connect a Vercel Sandbox account");
  });

  it("shows visible progress when an active run has no messages yet", () => {
    const html = renderToStaticMarkup(
      createElement(SessionWalliePanel, {
        initialData: data({
          runs: [
            run({
              finishedAt: null,
              isActive: true,
              isTerminal: false,
              messages: [],
              status: "running",
            }),
          ],
        }),
        memberIndex: new Map([[baseMember.id, baseMember]]),
        session: { id: "sess-1", workspaceId: "ws-1" },
        supabase: {} as SupabaseClient<Database>,
        workspaceSlug: "acme",
      }),
    );

    expect(html).toContain("Wallie is working");
    expect(html).not.toContain("Messages will appear here as the processor");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("No persisted messages were recorded for this run.");
  });

  it("keeps the progress row visible while an active run has messages", () => {
    const html = renderToStaticMarkup(
      createElement(SessionWalliePanel, {
        initialData: data({
          runs: [
            run({
              finishedAt: null,
              isActive: true,
              isTerminal: false,
              status: "running",
            }),
          ],
        }),
        memberIndex: new Map([[baseMember.id, baseMember]]),
        session: { id: "sess-1", workspaceId: "ws-1" },
        supabase: {} as SupabaseClient<Database>,
        workspaceSlug: "acme",
      }),
    );

    expect(html).toContain("Wallie is working");
    expect(html).toContain("Product spec created.");
    expect(html.indexOf("Wallie is working")).toBeGreaterThan(
      html.indexOf("Product spec created."),
    );
    expect(html).not.toContain("Messages will appear here as the processor");
  });

  it("keeps the terminal empty-message state for completed runs", () => {
    const html = renderToStaticMarkup(
      createElement(SessionWalliePanel, {
        initialData: data({
          runs: [run({ messages: [], status: "success" })],
        }),
        memberIndex: new Map([[baseMember.id, baseMember]]),
        session: { id: "sess-1", workspaceId: "ws-1" },
        supabase: {} as SupabaseClient<Database>,
        workspaceSlug: "acme",
      }),
    );

    expect(html).toContain("No persisted messages were recorded for this run.");
    expect(html).not.toContain("Wallie is working.");
  });

  it("shows persisted error messages for failed runs instead of the empty-message state", () => {
    const html = renderToStaticMarkup(
      createElement(SessionWalliePanel, {
        initialData: data({
          runs: [
            run({
              canRetry: true,
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
        memberIndex: new Map([[baseMember.id, baseMember]]),
        session: { id: "sess-1", workspaceId: "ws-1" },
        supabase: {} as SupabaseClient<Database>,
        workspaceSlug: "acme",
      }),
    );

    expect(html).toContain("Vercel Sandbox credentials are required.");
    expect(html).not.toContain("No persisted messages were recorded for this run.");
  });

  it("falls back to a human-readable requester label when member names are blank", () => {
    const memberWithoutName = {
      ...baseMember,
      fullName: "",
      username: null,
    };

    const html = renderToStaticMarkup(
      createElement(SessionWalliePanel, {
        initialData: data({
          runs: [
            run({
              requestedByMember: memberWithoutName,
              requestedByMemberId: memberWithoutName.id,
            }),
          ],
        }),
        memberIndex: new Map([[memberWithoutName.id, memberWithoutName]]),
        session: { id: "sess-1", workspaceId: "ws-1" },
        supabase: {} as SupabaseClient<Database>,
        workspaceSlug: "acme",
      }),
    );

    expect(html).toContain("Requested by workspace owner");
    expect(html).not.toContain("unavailable member");
  });
});
