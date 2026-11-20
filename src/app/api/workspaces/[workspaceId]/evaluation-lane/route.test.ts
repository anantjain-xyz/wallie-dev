import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { GET, PUT } from "./route";

const workspaceId = "60410000-0000-4000-8000-000000000001";
const userId = "60410000-0000-4000-8000-000000000002";
const otherId = "60410000-0000-4000-8000-000000000003";
const endpoint = `http://wallie.test/api/workspaces/${workspaceId}/evaluation-lane`;
const params = Promise.resolve({ workspaceId });
const command = { expectedRevision: 0, paused: true, maxConcurrent: 4 };
const updatedAt = "2026-11-19T23:00:00+00:00";
const readArgs = { p_workspace_id: workspaceId, p_actor_user_id: userId };

function fixture(handle: (url: URL, body: unknown) => Response) {
  const write = vi.fn<typeof fetch>(async (input, init) =>
    handle(
      new URL(input instanceof Request ? input.url : input),
      JSON.parse(typeof init?.body === "string" ? init.body : "null"),
    ),
  );
  const admin = createClient<Database>("http://supabase.test", "service-fixture", {
    auth: { persistSession: false },
    global: { fetch: write },
  });
  mocks.access.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, user: { id: userId } },
  });
  mocks.admin.mockReturnValue(admin);
  return write;
}

function put(body: unknown = command) {
  return new Request(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("evaluation lane controls", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks workspace manager access and reads the unconfigured lane", async () => {
    fixture((url, body) => {
      expect(url.pathname).toBe("/rest/v1/rpc/get_factory_evaluation_lane");
      expect(body).toEqual(readArgs);
      return Response.json({
        workspace_id: workspaceId,
        paused: false,
        max_concurrent: 2,
        revision: 0,
        updated_at: null,
        updated_by: null,
      });
    });
    const response = await GET(new Request(endpoint), { params });
    expect(mocks.access).toHaveBeenCalledWith(workspaceId, { requireManager: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      lane: { paused: false, maxConcurrent: 2, revision: 0, updatedAt: null },
    });
  });

  it("writes the expected revision with the authenticated workspace and actor", async () => {
    fixture((url, body) => {
      expect(url.pathname).toBe("/rest/v1/rpc/configure_factory_evaluation_lane");
      expect(body).toEqual({
        ...readArgs,
        p_expected_revision: 0,
        p_paused: true,
        p_max_concurrent: 4,
      });
      return Response.json({
        workspace_id: workspaceId,
        paused: true,
        max_concurrent: 4,
        revision: 1,
        updated_at: updatedAt,
        updated_by: userId,
      });
    });
    const response = await PUT(put(), { params });
    expect(mocks.access).toHaveBeenCalledWith(workspaceId, { requireManager: true });
    expect(await response.json()).toEqual({
      lane: { paused: true, maxConcurrent: 4, revision: 1, updatedAt },
    });
  });

  it("rejects a nonmanager and invalid settings before calling a privileged RPC", async () => {
    fixture(() => Response.json({}));
    mocks.access.mockResolvedValueOnce({ ok: false, status: 403, error: "Access denied." });
    expect((await PUT(put(), { params })).status).toBe(403);
    expect((await PUT(put({ ...command, maxConcurrent: 17 }), { params })).status).toBe(400);
    expect((await PUT(put({ ...command, actorUserId: otherId }), { params })).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("returns a safe conflict when the lane revision changed", async () => {
    fixture(() => Response.json({ code: "PT409", message: "Internal details" }, { status: 409 }));
    const response = await PUT(put(), { params });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The evaluation lane changed. Reload before saving.",
    });
  });
});
