import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  loadDefaultPipelineForWorkspace: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/pipeline/stages", () => ({
  loadDefaultPipelineForWorkspace: mocked.loadDefaultPipelineForWorkspace,
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
  mocked.loadDefaultPipelineForWorkspace.mockResolvedValue({
    id: "pipeline-1",
    isDefault: true,
    name: "Default",
    operatingRulesMd: "",
    stages: [
      {
        anyoneCanApprove: false,
        approverMemberIds: [],
        description: "",
        id: PRODUCT_STAGE_ID,
        name: "Product",
        pipelineId: "pipeline-1",
        position: 1,
        promptTemplateMd: "",
        slug: "product",
      },
    ],
  });
}

function baseStage(overrides: Record<string, unknown> = {}) {
  return {
    anyoneCanApprove: false,
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
    operating_rules_md: string;
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
    await expect(response.json()).resolves.toMatchObject({
      pipeline: {
        id: "pipeline-1",
        stages: [{ slug: "product" }],
      },
      success: true,
    });
    expect(mocked.rpc).toHaveBeenCalledWith("rewrite_default_pipeline_with_approval_policy", {
      // Omitted from the body → undefined → RPC preserves existing rules.
      operating_rules_md: undefined,
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
    expect(mocked.loadDefaultPipelineForWorkspace).toHaveBeenCalledWith(
      mocked.createSupabaseAdminClient.mock.results[0]?.value,
      WORKSPACE_ID,
    );
  });

  it("forwards operating rules to the rewrite RPC", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Default",
      operatingRulesMd: "## Operating rules\n- Be autonomous.",
      stages: [baseStage()],
    });

    expect(response.status).toBe(200);
    expect(rpcArgs().operating_rules_md).toBe("## Operating rules\n- Be autonomous.");
  });

  it("forwards the anyone-can-approve policy to the rewrite RPC", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Default",
      stages: [baseStage({ anyoneCanApprove: true })],
    });

    expect(response.status).toBe(200);
    expect(rpcArgs().stage_payload).toEqual([baseStage({ anyoneCanApprove: true })]);
  });

  it("omits operating rules from the RPC when the caller does not send them", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Default",
      stages: [baseStage()],
    });

    expect(response.status).toBe(200);
    // undefined (not "") so supabase-js drops it from the JSON body and the RPC
    // default + coalesce preserves the pipeline's current rules.
    expect(rpcArgs().operating_rules_md).toBeUndefined();
  });

  it("rejects operating rules longer than the allowed limit", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Default",
      operatingRulesMd: "x".repeat(20001),
      stages: [baseStage()],
    });

    expect(response.status).toBe(400);
    expect(mocked.rpc).not.toHaveBeenCalled();
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

  it("rejects an empty stage list before calling the RPC", async () => {
    grantAccess();
    setupRpc();

    const response = await putPipeline({
      name: "Default",
      stages: [],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Pipeline must have at least one stage.",
    });
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("maps duplicate incoming stage IDs from SQL validation to 400", async () => {
    grantAccess();
    setupRpc({
      data: {
        duplicate_stage_ids: [PRODUCT_STAGE_ID],
        error_code: "duplicate_stage_id",
        ok: false,
      },
    });

    const response = await putPipeline({
      name: "Default",
      stages: [baseStage(), baseStage({ name: "Product copy", slug: "product-copy" })],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      duplicateStageIds: [PRODUCT_STAGE_ID],
      error: `Duplicate stage IDs: ${PRODUCT_STAGE_ID}`,
    });
  });
});
