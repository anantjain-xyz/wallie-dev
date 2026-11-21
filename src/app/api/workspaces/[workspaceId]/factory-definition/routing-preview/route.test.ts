import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  selectFactory: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));
vi.mock("@/lib/factory-definitions/storage", () => ({ selectFactory: mocked.selectFactory }));

import { POST } from "./route";

const workspaceId = "ad280000-0000-4000-8000-000000000001";
const factoryId = "ad280000-0000-4000-8000-000000000002";
const userId = "ad280000-0000-4000-8000-000000000003";
const draftId = "ad280000-0000-4000-8000-000000000004";
const otherDraftId = "ad280000-0000-4000-8000-000000000005";
const url = `http://localhost/api/workspaces/${workspaceId}/factory-definition/routing-preview`;
const payload = { expectedActivationNumber: 3, draftId, taskClassSlug: "review" };
const draftDigest = "b".repeat(64);
const decision = {
  version: 1,
  disposition: "escalated",
  source: null,
  reason: "unmatched_class",
  configuration: null,
  benchmarkCandidateKey: null,
  taskClassSlug: "review",
  taskClassId: null,
  ruleId: null,
  initialReason: null,
};

function authorize() {
  const supabase = {};
  const rpc = vi.fn().mockResolvedValue({ data: { draftId, draftDigest, decision }, error: null });
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: { supabase, user: { id: userId }, workspace: { id: workspaceId } },
  });
  mocked.createSupabaseAdminClient.mockReturnValue({ rpc });
  mocked.selectFactory.mockResolvedValue({ data: { id: factoryId }, error: null });
  return { rpc, supabase };
}

function post(body: unknown, requestedFactory?: string) {
  return POST(new Request(url, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ workspaceId, factoryId: requestedFactory }),
  });
}

beforeEach(() => vi.resetAllMocks());

describe("preview model routing", () => {
  it.each([undefined, factoryId])(
    "previews the scoped saved draft (%s)",
    async (requestedFactory) => {
      const { rpc, supabase } = authorize();
      const response = await post(payload, requestedFactory);

      expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId, {
        requireManager: true,
      });
      expect(mocked.selectFactory).toHaveBeenCalledWith(supabase, workspaceId, requestedFactory);
      expect(rpc).toHaveBeenCalledWith("preview_factory_model_routing", {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
        p_actor_user_id: userId,
        p_expected_activation_number: payload.expectedActivationNumber,
        p_draft_id: draftId,
        p_task_class_slug: payload.taskClassSlug,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ draftId, draftDigest, decision });
    },
  );

  it("requires manager access before using a privileged client", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Denied.",
    });
    expect((await post(payload)).status).toBe(403);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied authority and a factory the actor cannot read", async () => {
    authorize();
    expect((await post({ ...payload, actorUserId: userId })).status).toBe(400);
    mocked.selectFactory.mockResolvedValue({ data: null, error: null });
    expect((await post(payload, factoryId)).status).toBe(404);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns a stale response for either a changed head or a mismatched result", async () => {
    const { rpc } = authorize();
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PT409" } });
    rpc.mockResolvedValueOnce({
      data: { draftId: otherDraftId, draftDigest, decision },
      error: null,
    });
    expect((await post(payload)).status).toBe(409);
    expect((await post(payload)).status).toBe(409);
  });
});
