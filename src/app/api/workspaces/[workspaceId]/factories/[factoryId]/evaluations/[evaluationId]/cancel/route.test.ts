import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { POST } from "./route";

const workspaceId = "60420000-0000-4000-8000-000000000001";
const factoryId = "60420000-0000-4000-8000-000000000002";
const evaluationId = "60420000-0000-4000-8000-000000000003";
const userId = "60420000-0000-4000-8000-000000000004";
const finishedAt = "2026-11-19T23:00:00+00:00";
const endpoint = `http://wallie.test/api/workspaces/${workspaceId}/factories/${factoryId}/evaluations/${evaluationId}/cancel`;
const params = Promise.resolve({ workspaceId, factoryId, evaluationId });

function fixture({
  visible = true,
  handler,
}: { visible?: boolean; handler?: (body: unknown) => Response } = {}) {
  const client = createClient<Database>("http://supabase.test", "reader", {
    auth: { persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.pathname).toBe("/rest/v1/factories");
        expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(url.searchParams.get("id")).toBe(`eq.${factoryId}`);
        return Response.json(visible ? { id: factoryId } : null);
      },
    },
  });
  const admin = createClient<Database>("http://supabase.test", "service-fixture", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.pathname).toBe("/rest/v1/rpc/cancel_factory_evaluation_job");
        expect(url.searchParams.get("select")).toBe(
          "id,workspace_id,factory_id,status,finished_at",
        );
        expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.pgrst.object+json");
        return (
          handler?.(JSON.parse(typeof init?.body === "string" ? init.body : "null")) ??
          Response.json({})
        );
      },
    },
  });
  mocks.access.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, user: { id: userId }, supabase: client },
  });
  mocks.admin.mockReturnValue(admin);
}

function cancel() {
  return POST(new Request(endpoint, { method: "POST" }), { params });
}

describe("evaluation cancellation", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(["canceled", "failed", "succeeded"])(
    "returns the exact terminal state %s",
    async (status) => {
      fixture({
        handler: (body) => {
          expect(body).toEqual({
            p_workspace_id: workspaceId,
            p_factory_id: factoryId,
            p_actor_user_id: userId,
            p_job_id: evaluationId,
          });
          return Response.json({
            id: evaluationId,
            workspace_id: workspaceId,
            factory_id: factoryId,
            status,
            finished_at: finishedAt,
            lease_token: "never expose control fields",
          });
        },
      });
      const response = await cancel();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        evaluation: { id: evaluationId, status, finishedAt },
      });
    },
  );

  it("hides inaccessible factories before calling the privileged client", async () => {
    fixture({ visible: false });
    expect((await cancel()).status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", 403],
    ["P0002", 404],
  ])("preserves the scoped SQL error %s", async (code, status) => {
    fixture({
      handler: () => Response.json({ code, message: "Internal details" }, { status: 400 }),
    });
    const response = await cancel();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("Internal details");
  });
});
