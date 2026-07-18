import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadAuthenticatedWorkspaceContext: vi.fn(),
}));

vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocked.loadAuthenticatedWorkspaceContext,
}));

vi.mock("@/lib/server-timing", () => ({
  approximatePayloadSizeBytes: (value: unknown) => Buffer.byteLength(JSON.stringify(value)),
  withServerTiming: async (
    _name: string,
    _metadata: unknown,
    operation: (timing: {
      segment: (_name: string, operation: () => unknown) => unknown;
    }) => unknown,
  ) =>
    operation({
      segment: async (_name, segmentOperation) => segmentOperation(),
    }),
}));

import {
  decodePipelineDashboardCursor,
  loadPipelineDashboardData,
  normalizePipelineDashboardRpcPayload,
} from "@/features/pipeline/data";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_PIPELINE_ID = "10000000-0000-4000-8000-000000000001";
const HISTORICAL_PIPELINE_ID = "20000000-0000-4000-8000-000000000001";
const PLAN_STAGE_ID = "30000000-0000-4000-8000-000000000001";
const VERIFY_STAGE_ID = "40000000-0000-4000-8000-000000000001";

function card(index: number, stageId = PLAN_STAGE_ID, pipelineId = DEFAULT_PIPELINE_ID) {
  return {
    createdAt: "2026-07-17T00:00:00.000Z",
    currentStageId: stageId,
    id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    linearIssueId: null,
    linearIssueUrl: null,
    number: index,
    phaseStatus: index % 2 === 0 ? "awaiting_review" : "agent_generating",
    pipelineId,
    pullRequests: [],
    rejectionCount: 0,
    title: `Session ${index}`,
    updatedAt: `2026-07-17T00:${String(index).padStart(2, "0")}:00.000Z`,
    workspaceId: WORKSPACE_ID,
  };
}

function cursor(stageId = PLAN_STAGE_ID, pipelineId = DEFAULT_PIPELINE_ID) {
  return {
    attentionRank: 1,
    id: card(25, stageId, pipelineId).id,
    pipelineId,
    snapshotAt: "2026-07-17T01:00:00.000Z",
    stageId,
    updatedAt: "2026-07-17T00:25:00.000Z",
  };
}

function lane({
  cards = [],
  id = PLAN_STAGE_ID,
  isDefault = true,
  pipelineId = DEFAULT_PIPELINE_ID,
  pipelineName = "Custom delivery",
  totalCount = cards.length,
}: {
  cards?: ReturnType<typeof card>[];
  id?: string;
  isDefault?: boolean;
  pipelineId?: string;
  pipelineName?: string;
  totalCount?: number;
} = {}) {
  return {
    cards,
    cursor: totalCount > cards.length ? cursor(id, pipelineId) : null,
    description: "A workspace-defined stage.",
    id,
    name: id === VERIFY_STAGE_ID ? "Verify" : "Plan",
    pipeline: { id: pipelineId, isDefault, name: pipelineName },
    position: 1,
    slug: id === VERIFY_STAGE_ID ? "verify" : "plan",
    totalCount,
  };
}

describe("Pipeline dashboard data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves custom, empty, and historical pinned-pipeline lanes", () => {
    const normalized = normalizePipelineDashboardRpcPayload({
      lanes: [
        lane(),
        lane({ cards: [], id: VERIFY_STAGE_ID }),
        lane({
          cards: [card(1, VERIFY_STAGE_ID, HISTORICAL_PIPELINE_ID)],
          id: VERIFY_STAGE_ID,
          isDefault: false,
          pipelineId: HISTORICAL_PIPELINE_ID,
          pipelineName: "2025 workflow",
        }),
      ],
    });

    expect(
      normalized.lanes.map(({ id, pipeline, totalCount }) => ({ id, pipeline, totalCount })),
    ).toEqual([
      {
        id: PLAN_STAGE_ID,
        pipeline: { id: DEFAULT_PIPELINE_ID, isDefault: true, name: "Custom delivery" },
        totalCount: 0,
      },
      {
        id: VERIFY_STAGE_ID,
        pipeline: { id: DEFAULT_PIPELINE_ID, isDefault: true, name: "Custom delivery" },
        totalCount: 0,
      },
      {
        id: VERIFY_STAGE_ID,
        pipeline: {
          id: HISTORICAL_PIPELINE_ID,
          isDefault: false,
          name: "2025 workflow",
        },
        totalCount: 1,
      },
    ]);
  });

  it("defensively caps an oversized lane at 25 cards and returns a stable cursor", () => {
    const normalized = normalizePipelineDashboardRpcPayload({
      lanes: [
        lane({ cards: Array.from({ length: 26 }, (_, index) => card(index + 1)), totalCount: 30 }),
      ],
    });

    expect(normalized.lanes[0]?.cards).toHaveLength(25);
    expect(normalized.lanes[0]?.totalCount).toBe(30);
    const decoded = decodePipelineDashboardCursor(normalized.lanes[0]?.cursor ?? null);
    expect(decoded).toEqual(cursor());
  });

  it("starts onboarding and the board RPC concurrently after auth", async () => {
    const starts: string[] = [];
    let resolveOnboarding!: (value: unknown) => void;
    let resolveDashboard!: (value: unknown) => void;
    const onboardingPromise = new Promise((resolve) => {
      resolveOnboarding = resolve;
    });
    const dashboardPromise = new Promise((resolve) => {
      resolveDashboard = resolve;
    });
    const onboardingQuery = {
      eq: () => onboardingQuery,
      maybeSingle: () => {
        starts.push("onboarding");
        return onboardingPromise;
      },
      select: () => onboardingQuery,
    };
    const supabase = {
      from: () => onboardingQuery,
      rpc(this: unknown) {
        expect(this).toBe(supabase);
        starts.push("dashboard");
        return dashboardPromise;
      },
    };
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      supabase,
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    });

    const resultPromise = loadPipelineDashboardData("wallie");
    await vi.waitFor(() => expect(starts).toEqual(["onboarding", "dashboard"]));

    resolveOnboarding({ data: { current_step: "verify", status: "completed" }, error: null });
    resolveDashboard({ data: { lanes: [lane()] }, error: null });

    await expect(resultPromise).resolves.toMatchObject({
      lanes: [{ cards: [], id: PLAN_STAGE_ID }],
    });
  });

  it("serializes only board fields, without prompts or approver metadata", () => {
    const payload = normalizePipelineDashboardRpcPayload({ lanes: [lane({ cards: [card(1)] })] });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("promptTemplate");
    expect(serialized).not.toContain("prompt_template");
    expect(serialized).not.toContain("approver");
    expect(serialized).toContain("Session 1");
  });
});
