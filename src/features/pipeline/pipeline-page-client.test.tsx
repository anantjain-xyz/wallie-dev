// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseBrowserClient: vi.fn(),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: mocked.createSupabaseBrowserClient,
}));

vi.mock("@/features/sessions/components/session-detail-link", () => ({
  SessionDetailLink: ({ "aria-label": ariaLabel }: { "aria-label": string }) => (
    <a aria-label={ariaLabel} href="#" />
  ),
  SessionDetailLinkPrefetchBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/features/sessions/components/session-connections", () => ({
  SessionConnections: () => null,
}));

vi.mock("@/features/sessions/components/session-phase-status-label", () => ({
  SessionPhaseStatusLabel: ({ status }: { status: string }) => <span>{status}</span>,
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

function card(number: number, stageId: string): PipelineDashboardCard {
  return {
    createdAt: "2026-07-17T00:00:00.000Z",
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
    updatedAt: `2026-07-17T00:0${number}:00.000Z`,
    workspaceId: WORKSPACE_ID,
  };
}

function initialData(): PipelineDashboardData {
  return {
    lanes: [
      {
        cards: [card(1, PLAN_STAGE_ID)],
        cursor: "opaque-plan-cursor",
        description: "Plan the work.",
        id: PLAN_STAGE_ID,
        name: "Plan",
        pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
        position: 1,
        slug: "plan",
        totalCount: 2,
      },
      {
        cards: [card(3, BUILD_STAGE_ID)],
        cursor: null,
        description: "Build the work.",
        id: BUILD_STAGE_ID,
        name: "Build",
        pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
        position: 2,
        slug: "build",
        totalCount: 1,
      },
    ],
    onboarding: null,
    workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
  };
}

describe("PipelinePageClient", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("appends Load more results without refetching or replacing another lane", async () => {
    const channel = {
      on: vi.fn(),
      subscribe: vi.fn(),
    };
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockReturnValue(channel);
    mocked.createSupabaseBrowserClient.mockReturnValue({
      channel: () => channel,
      removeChannel: vi.fn(),
    });
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
    await userEvent.click(screen.getAllByRole("button", { name: "Load more Plan sessions" })[0]!);

    await waitFor(() => expect(screen.getAllByText("Session 2").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Session 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Session 3").length).toBeGreaterThan(0);
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
});
