import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mocked.notFound,
  redirect: mocked.redirect,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import {
  loadSessionDetailPageData,
  SESSION_REVIEW_PAYLOAD_TARGET_BYTES,
  serializeSessionReviewData,
  type SessionReviewData,
} from "@/features/sessions/detail/data";
import type { WallieSessionRepository } from "@/features/wallie/types";
import { approximatePayloadSizeBytes } from "@/lib/server-timing";

const SEEDED_SESSION_18_BASELINE_RPC_BYTES = 10_603;
const detailMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260718000001_narrow_session_detail_page.sql"),
  "utf8",
);

function makeRpcPayload() {
  return {
    activity: {
      repository: null as WallieSessionRepository | null,
      sessionGithubRepositoryId: "repo-private-to-server",
      sessionId: "session-18",
      workspaceId: "workspace-private-to-server",
    },
    creatorDisplayName: "Anant Jain",
    currentMember: { preferences: "must-not-cross" },
    members: [{ fullName: "must-not-cross" }],
    session: {
      archivedAt: null,
      artifacts: [
        {
          createdAt: "2026-07-11T05:32:06.176Z",
          payload: "# Land\n\nMerged and deployed; storage bucket policies configured.",
          stageSlug: "land",
          version: 1,
        },
      ],
      createdAt: "2026-07-06T05:32:06.176Z",
      currentArtifactVersion: 1,
      currentStageId: "stage-land",
      currentStageName: "must-not-cross",
      currentStagePosition: 4,
      currentStageSlug: "land",
      id: "session-18",
      linearIssueId: null,
      linearIssueUrl: null,
      number: 18,
      phaseCompletions: [{ completedAt: "2026-07-06T17:32:06.176Z", stageSlug: "plan" }],
      phaseStatus: "awaiting_review" as const,
      pipeline: {
        id: "pipeline-private-to-server",
        isDefault: true,
        name: "Default",
        operatingRulesMd: "must-not-cross",
        stages: [
          {
            approverMemberIds: ["must-not-cross"],
            description: "Merge the approved change once CI is green.",
            id: "stage-land",
            name: "Land",
            pipelineId: "pipeline-private-to-server",
            position: 4,
            promptTemplateMd: "must-not-cross",
            slug: "land",
          },
        ],
      },
      pipelineId: "pipeline-private-to-server",
      promptMd: "Add workspace branding.",
      pullRequestCount: 0,
      pullRequests: [],
      rejectionCount: 1,
      title: "Custom workspace branding and logo upload",
      updatedAt: "2026-07-12T05:32:06.176Z",
      workspaceId: "workspace-private-to-server",
    },
    sessionGithubRepositoryId: "repo-private-to-server",
    workspaceSlug: "acme-corp",
  };
}

describe("session review RSC contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructs only the documented client fields without database spreads", () => {
    const review: SessionReviewData = serializeSessionReviewData(makeRpcPayload());

    expect(Object.keys(review)).toEqual(["creatorDisplayName", "session", "workspaceSlug"]);
    expect(Object.keys(review.session)).toEqual([
      "archivedAt",
      "artifacts",
      "createdAt",
      "currentArtifactVersion",
      "currentStageId",
      "currentStageSlug",
      "id",
      "linearIssueId",
      "linearIssueUrl",
      "number",
      "phaseCompletions",
      "phaseStatus",
      "pipeline",
      "promptMd",
      "pullRequests",
      "title",
      "updatedAt",
    ]);
    expect(Object.keys(review.session.pipeline)).toEqual(["stages"]);
    expect(Object.keys(review.session.pipeline.stages[0]!)).toEqual([
      "description",
      "id",
      "name",
      "position",
      "slug",
    ]);
    expect(JSON.stringify(review)).not.toContain("must-not-cross");
    expect(JSON.stringify(review)).not.toContain("private-to-server");
  });

  it("stays below the documented target and 25% under the seeded baseline", () => {
    const reviewBytes = approximatePayloadSizeBytes(serializeSessionReviewData(makeRpcPayload()));

    expect(reviewBytes).not.toBeNull();
    expect(reviewBytes!).toBeLessThanOrEqual(SESSION_REVIEW_PAYLOAD_TARGET_BYTES);
    expect(reviewBytes!).toBeLessThanOrEqual(SEEDED_SESSION_18_BASELINE_RPC_BYTES * 0.75);
  });
});

describe("session detail RPC access result", () => {
  it("folds the no-workspace signal into the existing detail RPC", () => {
    expect(detailMigration).toContain("'access', jsonb_build_object(");
    expect(detailMigration).toContain("'hasAnyWorkspace', v_has_any_workspace");
    expect(detailMigration).toContain("wm.user_id = auth.uid()");
    expect(detailMigration).toContain("and wm.is_active");
    expect(detailMigration).toContain("and wm.kind = 'human'");
  });
});

describe("session detail loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects signed-out deep links while starting auth and the detail RPC together", async () => {
    let resolveUser!: (user: null) => void;
    const userPromise = new Promise<null>((resolve) => {
      resolveUser = resolve;
    });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const from = vi.fn();

    mocked.createSupabaseServerClient.mockResolvedValue({ from, rpc });
    mocked.getSupabaseUserOrNull.mockReturnValue(userPromise);

    const loadPromise = loadSessionDetailPageData("acme-corp", "18");

    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    resolveUser(null);

    await expect(loadPromise).rejects.toThrow(
      "redirect:/login?next=%2Fw%2Facme-corp%2Fsessions%2F18",
    );
    expect(mocked.redirect).toHaveBeenCalledWith("/login?next=%2Fw%2Facme-corp%2Fsessions%2F18");
  });

  it("redirects authenticated users with no workspace memberships from the detail RPC", async () => {
    const from = vi.fn();
    const rpc = vi.fn().mockResolvedValue({
      data: { access: { hasAnyWorkspace: false } },
      error: null,
    });

    mocked.createSupabaseServerClient.mockResolvedValue({ from, rpc });
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-without-workspaces" });

    await expect(loadSessionDetailPageData("acme-corp", "18")).rejects.toThrow(
      "redirect:/onboarding/workspace",
    );

    expect(mocked.redirect).toHaveBeenCalledWith("/onboarding/workspace");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("returns not found when the user has another workspace but cannot access the target", async () => {
    const from = vi.fn();
    const rpc = vi.fn().mockResolvedValue({
      data: { access: { hasAnyWorkspace: true } },
      error: null,
    });

    mocked.createSupabaseServerClient.mockResolvedValue({ from, rpc });
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-with-another-workspace" });

    await expect(loadSessionDetailPageData("private-workspace", "18")).rejects.toThrow("not-found");

    expect(mocked.notFound).toHaveBeenCalledOnce();
    expect(mocked.redirect).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("resolves canReview and a slim repository for the workbench", async () => {
    const payload = makeRpcPayload();
    payload.activity.repository = {
      defaultBranch: "main",
      defaultProgrammingLanguage: null,
      fullName: "acme/app",
      htmlUrl: "https://github.com/acme/app",
      id: "repo-1",
      isArchived: false,
      isPrivate: true,
    };

    const memberQuery = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "member-1", role: "owner" },
        error: null,
      }),
      select: vi.fn().mockReturnThis(),
    };
    const stageQuery = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { approver_member_ids: [] },
        error: null,
      }),
      select: vi.fn().mockReturnThis(),
    };
    const runsQuery = {
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      order: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
    };
    const from = vi.fn((table: string) => {
      if (table === "workspace_members") return memberQuery;
      if (table === "pipeline_stages") return stageQuery;
      if (table === "agent_runs") return runsQuery;
      throw new Error(`unexpected table ${table}`);
    });
    const rpc = vi.fn().mockResolvedValue({ data: payload, error: null });

    mocked.createSupabaseServerClient.mockResolvedValue({ from, rpc });
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });

    const result = await loadSessionDetailPageData("acme-corp", "18");

    expect(result.canReview).toBe(true);
    expect(result.hasFailedRun).toBe(false);
    expect(result.failedStageSlug).toBeNull();
    expect(result.repository).toEqual({
      defaultBranch: "main",
      fullName: "acme/app",
      htmlUrl: "https://github.com/acme/app",
    });
    expect(JSON.stringify(result.review)).not.toContain("must-not-cross");
  });
});
