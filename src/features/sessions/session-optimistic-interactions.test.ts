// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDetailPageClient } from "@/features/sessions/detail/session-detail-page-client";
import type { SessionDetailPageData } from "@/features/sessions/detail/data";
import { SessionsPageClient } from "@/features/sessions/list/sessions-page-client";
import type { SessionListPageData } from "@/features/sessions/list/data";
import type { SessionSummary } from "@/features/sessions/types";

const mocked = vi.hoisted(() => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);

  return {
    channel,
    fetch: vi.fn(),
    removeChannel: vi.fn(),
    replace: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocked.replace }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    channel: () => mocked.channel,
    removeChannel: mocked.removeChannel,
  }),
}));

vi.mock("@/features/sessions/detail/artifact-panel", () => ({
  ArtifactPanel: ({ isDrafting }: { isDrafting: boolean }) =>
    createElement("div", null, isDrafting ? "Drafting artifact" : "Artifact"),
}));

vi.mock("@/features/wallie/session-wallie-panel", () => ({
  SessionWalliePanel: () => null,
}));

const session: SessionSummary = {
  archivedAt: null,
  createdAt: "2026-07-17T10:00:00.000Z",
  currentArtifactVersion: 1,
  currentStageId: "stage-plan",
  currentStageName: "Plan",
  currentStagePosition: 0,
  currentStageSlug: "plan",
  id: "11111111-1111-4111-8111-111111111111",
  linearIssueId: null,
  linearIssueUrl: null,
  number: 1,
  phaseStatus: "awaiting_review",
  pipelineId: "pipeline-1",
  promptMd: "Ship the optimistic flow",
  pullRequestCount: 0,
  pullRequests: [],
  rejectionCount: 0,
  title: "Optimistic session",
  updatedAt: "2026-07-17T11:00:00.000Z",
  workspaceId: "workspace-1",
};

function makeDetailData(): SessionDetailPageData {
  return {
    currentMember: null,
    members: [],
    memberIndex: new Map(),
    session: {
      ...session,
      artifacts: [],
      phaseCompletions: [],
      pipeline: {
        id: "pipeline-1",
        isDefault: true,
        name: "Default",
        operatingRulesMd: "",
        stages: [
          {
            approverMemberIds: [],
            description: "Plan",
            id: "stage-plan",
            name: "Plan",
            pipelineId: "pipeline-1",
            position: 0,
            promptTemplateMd: "",
            slug: "plan",
          },
          {
            approverMemberIds: [],
            description: "Build",
            id: "stage-build",
            name: "Build",
            pipelineId: "pipeline-1",
            position: 1,
            promptTemplateMd: "",
            slug: "build",
          },
        ],
      },
    },
    sessionCreator: null,
    sessionGithubRepositoryId: null,
    wallie: {
      blockingReasons: [],
      canEnqueue: false,
      loadedMessageRunIds: [],
      missingSecretKeys: [],
      mode: "code",
      repository: null,
      requiredSecretKeys: [],
      requiresVercelSandbox: false,
      runs: [],
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: null,
        projectId: null,
        projectName: null,
        status: "missing",
        teamId: null,
      },
    },
    workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
  };
}

function makeListData(summary: SessionSummary, scope: "all" | "archived"): SessionListPageData {
  return {
    hasAnySession: true,
    hasMore: false,
    nextCursor: null,
    onboarding: null,
    queryState: { cursor: null, query: "", scope, stageSlug: null },
    sessions: [summary],
    stageFacets: [{ count: 1, name: "Plan", position: 0, slug: "plan" }],
    totalCount: 1,
    workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
  };
}

describe("optimistic session interactions", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocked.fetch);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocked.channel.on.mockReturnValue(mocked.channel);
    mocked.channel.subscribe.mockReturnValue(mocked.channel);
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
  });

  it("does not expose Stop while a delayed approval is still pending", async () => {
    let releaseResponse!: () => void;
    mocked.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseResponse = () =>
            resolve(
              Response.json({
                archivedAt: null,
                artifactVersion: 0,
                currentStageId: "stage-build",
                id: session.id,
                phaseStatus: "agent_generating",
                rejectionCount: 0,
                updatedAt: "2026-07-17T12:00:00.000Z",
              }),
            );
        }),
    );

    render(
      createElement(SessionDetailPageClient, {
        initialData: makeDetailData(),
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & advance" }));

    expect(screen.getByText("Drafting artifact")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Approving/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();

    await act(async () => releaseResponse());
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Stop run" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("uses newer archive props when a keyed row survives soft navigation", () => {
    const view = render(
      createElement(SessionsPageClient, { initialData: makeListData(session, "all") }),
    );
    expect(screen.getByRole("link", { name: /Open session #1/ })).toBeTruthy();

    view.rerender(
      createElement(SessionsPageClient, {
        initialData: makeListData(
          {
            ...session,
            archivedAt: "2026-07-17T12:00:00.000Z",
            phaseStatus: "rejected",
            updatedAt: "2026-07-17T12:00:00.000Z",
          },
          "archived",
        ),
      }),
    );

    expect(screen.getByRole("link", { name: /Open session #1/ })).toBeTruthy();
    expect(screen.getByText("Archived", { exact: true })).toBeTruthy();
  });

  it("hides an unarchived row optimistically before the response settles", () => {
    mocked.fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const archived = {
      ...session,
      archivedAt: "2026-07-17T12:00:00.000Z",
      updatedAt: "2026-07-17T12:00:00.000Z",
    };
    render(
      createElement(SessionsPageClient, {
        initialData: makeListData(archived, "archived"),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Unarchive session #1" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unarchive for session #1" }));

    expect(screen.queryByRole("link", { name: /Open session #1/ })).toBeNull();
  });
});
