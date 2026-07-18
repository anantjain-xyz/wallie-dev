// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  cardLinkRenders: new Map<string, number>(),
  createSupabaseBrowserClient: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocked.refresh }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: mocked.createSupabaseBrowserClient,
}));

vi.mock("@/features/sessions/components/session-detail-link", () => ({
  SessionDetailLink: ({
    "aria-label": ariaLabel,
    className,
    href,
  }: {
    "aria-label": string;
    className?: string;
    href: string;
  }) => {
    mocked.cardLinkRenders.set(ariaLabel, (mocked.cardLinkRenders.get(ariaLabel) ?? 0) + 1);
    return <a aria-label={ariaLabel} className={className} href={href} />;
  },
  SessionDetailLinkPrefetchBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/features/sessions/components/session-connections", () => ({
  SessionConnections: () => null,
}));

vi.mock("@/features/sessions/components/sessions-zero-state", () => ({
  SessionsZeroState: () => <p>No sessions</p>,
}));

import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";
import type { PipelineDashboardCard, PipelineDashboardData } from "@/features/pipeline/types";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const PIPELINE_ID = "10000000-0000-4000-8000-000000000001";
const PLAN_STAGE_ID = "20000000-0000-4000-8000-000000000001";
const BUILD_STAGE_ID = "30000000-0000-4000-8000-000000000001";
const REVIEW_STAGE_ID = "50000000-0000-4000-8000-000000000001";

type RealtimePayload = { eventType: string; new: unknown; old?: unknown };

function card(number: number, stageId: string): PipelineDashboardCard {
  const updatedAt = new Date(Date.UTC(2026, 6, 17) + number * 1_000).toISOString();
  return {
    createdAt: updatedAt,
    currentStageId: stageId,
    id: `40000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    linearIssueId: null,
    linearIssueUrl: null,
    number,
    phaseStatus: "agent_generating",
    pipelineId: PIPELINE_ID,
    pullRequests: [],
    rejectionCount: 0,
    title: `Session ${number}`,
    updatedAt,
    workspaceId: WORKSPACE_ID,
  };
}

function initialData(
  planCards = [card(1, PLAN_STAGE_ID)],
  buildCards = [card(3, BUILD_STAGE_ID)],
): PipelineDashboardData {
  return {
    lanes: [
      {
        cards: planCards,
        cursor: "opaque-plan-cursor",
        description: "Plan the work.",
        id: PLAN_STAGE_ID,
        name: "Plan",
        pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
        position: 1,
        slug: "plan",
        totalCount: Math.max(2, planCards.length),
      },
      {
        cards: buildCards,
        cursor: null,
        description: "Build the work.",
        id: BUILD_STAGE_ID,
        name: "Build",
        pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
        position: 2,
        slug: "build",
        totalCount: buildCards.length,
      },
    ],
    onboarding: null,
    workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
  };
}

function sessionRow(session: PipelineDashboardCard) {
  return {
    archived_at: null,
    created_at: session.createdAt,
    creator_member_id: null,
    current_artifact_version: 1,
    current_stage_id: session.currentStageId,
    github_repository_id: null,
    id: session.id,
    linear_issue_id: session.linearIssueId,
    linear_issue_url: session.linearIssueUrl,
    number: session.number,
    phase_status: session.phaseStatus,
    pipeline_id: session.pipelineId,
    prompt_md: "",
    rejection_count: session.rejectionCount,
    search_document: null,
    search_text: null,
    title: session.title,
    updated_at: session.updatedAt,
    workspace_id: session.workspaceId,
  };
}

function installSupabaseMock() {
  let sessionsHandler: ((payload: RealtimePayload) => void) | undefined;
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockImplementation(
    (_event: string, filter: { table: string }, handler: (payload: RealtimePayload) => void) => {
      if (filter.table === "sessions") sessionsHandler = handler;
      return channel;
    },
  );
  channel.subscribe.mockReturnValue(channel);
  mocked.createSupabaseBrowserClient.mockReturnValue({
    channel: () => channel,
    removeChannel: vi.fn(),
  });

  return {
    getSessionsHandler: () => sessionsHandler,
  };
}

describe("PipelinePageClient", () => {
  afterEach(() => {
    cleanup();
    mocked.cardLinkRenders.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders one semantic card tree with the same mobile selector names and destinations", async () => {
    installSupabaseMock();
    render(<PipelinePageClient initialData={initialData()} />);

    expect(screen.getAllByText("Session 1")).toHaveLength(1);
    expect(screen.getAllByText("Session 3")).toHaveLength(1);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Open session Session 1" }).getAttribute("href")).toBe(
      "/w/wallie/sessions/1",
    );

    const selector = screen.getByRole("combobox", { name: "Pipeline stage" });
    expect(within(selector).getByRole("option", { name: "Plan (2)" })).toBeTruthy();
    await userEvent.selectOptions(selector, `${PIPELINE_ID}:${BUILD_STAGE_ID}`);

    expect(
      screen
        .getByRole("heading", { name: "Plan" })
        .closest("section")
        ?.classList.contains("hidden"),
    ).toBe(true);
    expect(
      screen.getByRole("heading", { name: "Build" }).closest("section")?.classList.contains("flex"),
    ).toBe(true);
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("appends Load more results without refetching or replacing another lane", async () => {
    installSupabaseMock();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          lane: {
            cards: [card(2, PLAN_STAGE_ID)],
            cursor: null,
            id: PLAN_STAGE_ID,
            pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
            totalCount: 2,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PipelinePageClient initialData={initialData()} />);
    await userEvent.click(screen.getByRole("button", { name: "Load more Plan sessions" }));

    await waitFor(() => expect(screen.getByText("Session 2")).toBeTruthy());
    expect(screen.getByText("Session 1")).toBeTruthy();
    expect(screen.getByText("Session 3")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/workspaces/${WORKSPACE_ID}/pipeline-dashboard`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      cursor: "opaque-plan-cursor",
      pipelineId: PIPELINE_ID,
      seenIds: [card(1, PLAN_STAGE_ID).id],
      stageId: PLAN_STAGE_ID,
    });
    expect(screen.queryByRole("button", { name: "Load more Plan sessions" })).toBeNull();
  });

  it("preserves keyboard focus when realtime moves a card between known stages", async () => {
    const supabase = installSupabaseMock();
    render(<PipelinePageClient initialData={initialData()} />);
    await waitFor(() => expect(supabase.getSessionsHandler()).toBeDefined());

    const sessionLink = screen.getByRole("link", { name: "Open session Session 1" });
    sessionLink.focus();
    expect(document.activeElement).toBe(sessionLink);

    const moved = {
      ...card(1, BUILD_STAGE_ID),
      updatedAt: "2026-07-18T06:00:00.000Z",
    };
    act(() => {
      supabase.getSessionsHandler()?.({ eventType: "UPDATE", new: sessionRow(moved) });
    });

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("link", { name: "Open session Session 1" }),
      ),
    );
    expect(
      within(screen.getByRole("heading", { name: "Build" }).closest("section")!).getByText(
        "Session 1",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Session 1")).toHaveLength(1);
  });

  it("refreshes unknown realtime lanes and reconciles authoritative lane metadata", async () => {
    const supabase = installSupabaseMock();
    const originalData = initialData();
    const view = render(<PipelinePageClient initialData={originalData} />);
    await waitFor(() => expect(supabase.getSessionsHandler()).toBeDefined());

    const movedCard = card(1, REVIEW_STAGE_ID);
    act(() => {
      supabase.getSessionsHandler()?.({ eventType: "UPDATE", new: sessionRow(movedCard) });
      supabase.getSessionsHandler()?.({ eventType: "UPDATE", new: sessionRow(movedCard) });
    });

    expect(mocked.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Session 1")).toBeTruthy();

    const refreshedData: PipelineDashboardData = {
      ...originalData,
      lanes: [
        { ...originalData.lanes[0]!, cards: [], totalCount: 0 },
        originalData.lanes[1]!,
        {
          cards: [movedCard],
          cursor: null,
          description: "Review the work.",
          id: REVIEW_STAGE_ID,
          name: "Review",
          pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
          position: 3,
          slug: "review",
          totalCount: 1,
        },
      ],
    };

    view.rerender(<PipelinePageClient initialData={refreshedData} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy());
    expect(screen.getAllByText("Session 1")).toHaveLength(1);
    expect(screen.getByText("Session 3")).toBeTruthy();
  });

  it("keeps a Profiler commit bounded to one card with 100 seeded sessions", async () => {
    const supabase = installSupabaseMock();
    const planCards = Array.from({ length: 50 }, (_, index) => card(index + 1, PLAN_STAGE_ID));
    const buildCards = Array.from({ length: 50 }, (_, index) => card(index + 51, BUILD_STAGE_ID));
    const commits: Array<{ id: string; phase: string }> = [];
    const onRender: ProfilerOnRenderCallback = (id, phase) => {
      commits.push({ id, phase });
    };

    render(
      <Profiler id="pipeline-board" onRender={onRender}>
        <PipelinePageClient initialData={initialData(planCards, buildCards)} />
      </Profiler>,
    );
    await waitFor(() => expect(supabase.getSessionsHandler()).toBeDefined());
    expect(screen.getAllByRole("article")).toHaveLength(100);
    commits.length = 0;
    mocked.cardLinkRenders.clear();

    const updated = {
      ...planCards[0]!,
      phaseStatus: "awaiting_review" as const,
      title: "Session 1 updated",
      updatedAt: "2026-07-18T08:00:00.000Z",
    };
    act(() => {
      supabase.getSessionsHandler()?.({ eventType: "UPDATE", new: sessionRow(updated) });
    });

    await waitFor(() => expect(screen.getByText("Session 1 updated")).toBeTruthy());
    expect(commits).toEqual([{ id: "pipeline-board", phase: "update" }]);
    expect([...mocked.cardLinkRenders.entries()]).toEqual([["Open session Session 1 updated", 1]]);
    expect(screen.getAllByRole("article")).toHaveLength(100);
  });
});
