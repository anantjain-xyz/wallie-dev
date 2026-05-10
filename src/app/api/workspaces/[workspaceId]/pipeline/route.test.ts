import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { PUT } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const PRODUCT_STAGE_ID = "11111111-1111-4111-8111-111111111111";
const DESIGN_STAGE_ID = "22222222-2222-4222-8222-222222222222";
const ENGINEERING_STAGE_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const UNKNOWN_MEMBER_ID = "55555555-5555-4555-8555-555555555555";

function requestWith(body: unknown) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/pipeline`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

function routeContext() {
  return {
    params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
  };
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: {
      currentMember: { id: MEMBER_ID, is_active: true, kind: "human", role: "owner" },
      supabase: {},
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
  });
}

function setupRpc(result: { data?: unknown; error?: { message: string } } = {}) {
  mocked.rpc.mockResolvedValue({
    data: result.data ?? { ok: true },
    error: result.error ?? null,
  });
  mocked.createSupabaseAdminClient.mockReturnValue({
    rpc: mocked.rpc,
  });
}

function baseStage(overrides: Record<string, unknown> = {}) {
  return {
    approverMemberIds: [],
    description: "",
    id: PRODUCT_STAGE_ID,
    name: "Product",
    promptTemplateMd: "",
    slug: "product",
    ...overrides,
  };
}

async function putPipeline(body: unknown) {
  return PUT(requestWith(body), routeContext());
}

function rpcArgs() {
  return mocked.rpc.mock.calls[0]?.[1] as {
    pipeline_name: string;
    stage_payload: Array<Record<string, unknown>>;
    target_workspace_id: string;
  };
}

describe("PUT /api/workspaces/[workspaceId]/pipeline", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("saves a valid pipeline through the atomic rewrite RPC", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Default",
      stages: [
        baseStage({ approverMemberIds: [MEMBER_ID] }),
        baseStage({
          id: DESIGN_STAGE_ID,
          name: "Design",
          promptTemplateMd: "Design prompt",
          slug: "design",
        }),
      ],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mocked.rpc).toHaveBeenCalledWith("rewrite_default_pipeline", {
      pipeline_name: "Default",
      stage_payload: [
        baseStage({ approverMemberIds: [MEMBER_ID] }),
        baseStage({
          id: DESIGN_STAGE_ID,
          name: "Design",
          promptTemplateMd: "Design prompt",
          slug: "design",
        }),
      ],
      target_workspace_id: WORKSPACE_ID,
    });
  });

  it("surfaces a mid-write RPC failure after the single transactional call", async () => {
    grantAccess();
    setupRpc({
      error: { message: "duplicate key value violates unique constraint" },
    });

    const response = await putPipeline({
      name: "Default",
      stages: [baseStage(), baseStage({ id: DESIGN_STAGE_ID, name: "Design", slug: "design" })],
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "duplicate key value violates unique constraint",
    });
    expect(mocked.rpc).toHaveBeenCalledTimes(1);
    expect(mocked.createSupabaseAdminClient.mock.results[0]?.value).not.toHaveProperty("from");
  });

  it("passes rename-only PUTs to the RPC without direct table writes", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Renamed pipeline",
      stages: [baseStage(), baseStage({ id: DESIGN_STAGE_ID, name: "Design", slug: "design" })],
    });

    expect(response.status).toBe(200);
    expect(rpcArgs().pipeline_name).toBe("Renamed pipeline");
    expect(rpcArgs().stage_payload.map((stage) => stage.id)).toEqual([
      PRODUCT_STAGE_ID,
      DESIGN_STAGE_ID,
    ]);
  });

  it("preserves reorder PUT order in the RPC payload", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Default",
      stages: [baseStage({ id: DESIGN_STAGE_ID, name: "Design", slug: "design" }), baseStage()],
    });

    expect(response.status).toBe(200);
    expect(rpcArgs().stage_payload.map((stage) => stage.slug)).toEqual(["design", "product"]);
  });

  it("passes add+remove+reorder PUTs to the same atomic RPC", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Default",
      stages: [
        baseStage({ id: DESIGN_STAGE_ID, name: "Design", slug: "design" }),
        {
          description: "Build it",
          name: "Engineering",
          promptTemplateMd: "Engineering prompt",
          slug: "engineering",
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(rpcArgs().stage_payload).toEqual([
      baseStage({ id: DESIGN_STAGE_ID, name: "Design", slug: "design" }),
      {
        approverMemberIds: [],
        description: "Build it",
        name: "Engineering",
        promptTemplateMd: "Engineering prompt",
        slug: "engineering",
      },
    ]);
  });

  it("maps active-session deletion blocks from the RPC to 409", async () => {
    grantAccess();
    setupRpc({
      data: {
        blocking_session_numbers: [17, 18],
        error_code: "stage_delete_blocked",
        ok: false,
      },
    });

    const response = await putPipeline({
      name: "Default",
      stages: [baseStage()],
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("#17, #18");
  });

  it("returns 400 with invalid approver member IDs instead of dropping them", async () => {
    grantAccess();
    setupRpc({
      data: {
        error_code: "unknown_approver_member_ids",
        invalid_approver_member_ids: [UNKNOWN_MEMBER_ID],
        ok: false,
      },
    });

    const response = await putPipeline({
      name: "Default",
      stages: [baseStage({ approverMemberIds: [UNKNOWN_MEMBER_ID] })],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: `Unknown approver member IDs: ${UNKNOWN_MEMBER_ID}`,
      invalidApproverMemberIds: [UNKNOWN_MEMBER_ID],
    });
  });

  it("maps SQL slug uniqueness validation to 400", async () => {
    grantAccess();
    setupRpc({
      data: {
        duplicate_stage_slugs: ["product"],
        error_code: "duplicate_stage_slug",
        ok: false,
      },
    });

    const response = await putPipeline({
      name: "Default",
      stages: [
        baseStage(),
        baseStage({ id: ENGINEERING_STAGE_ID, name: "Product 2", slug: "product" }),
      ],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Duplicate stage slug: product" });
  });
});
