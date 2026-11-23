import { beforeEach, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const { user, session, rpc, rateLimit } = vi.hoisted(() => ({
  user: vi.fn(),
  session: vi.fn(),
  rpc: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: user }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: session }) }),
    }),
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: rateLimit }));

const sessionId = "d8956e9d-bf42-4273-99f8-73411803b7fb";
const requestId = "243ed945-5596-4960-836e-5a45c59eb024";
const params = { params: Promise.resolve({ sessionId }) };
const endpoint = "https://wallie.test/api/sessions/" + sessionId + "/workflow-lifecycle";
const scope = {
  p_root_session_id: sessionId,
  p_workspace_id: "workspace",
  p_factory_id: "factory",
};

function action(body: object = { requestId, expectedGeneration: 3, action: "pause" }) {
  return new Request(endpoint, { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetAllMocks();
  user.mockResolvedValue({ id: "manager" });
  session.mockResolvedValue({
    data: { id: sessionId, workspace_id: "workspace", factory_id: "factory" },
    error: null,
  });
  rateLimit.mockResolvedValue({});
});

it("returns the current generation and state through the session's RLS scope", async () => {
  rpc.mockResolvedValue({
    data: { execution: { generation: 3, lifecycle_status: "paused", secret: "private" } },
  });
  const response = await GET(new Request(endpoint), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ generation: 3, status: "paused" });
  expect(rpc).toHaveBeenCalledWith("read_factory_workflow_execution", scope);
});

it("uses the authenticated operator and scope from the visible session", async () => {
  rpc.mockResolvedValue({ data: { requestId, generation: 4, lifecycleStatus: "paused" } });
  const response = await POST(action(), params);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ requestId, generation: 4, lifecycleStatus: "paused" });
  expect(rpc).toHaveBeenCalledWith("control_factory_workflow_lifecycle_for_user", {
    ...scope,
    p_actor_user_id: "manager",
    p_expected_generation: 3,
    p_request_id: requestId,
    p_action: "pause",
  });
});

it("rejects unauthenticated work and does not accept identity in the payload", async () => {
  user.mockResolvedValueOnce(null);
  expect((await POST(action(), params)).status).toBe(401);
  expect(
    (
      await POST(
        action({ requestId, expectedGeneration: 3, action: "pause", workspaceId: "different" }),
        params,
      )
    ).status,
  ).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});

it.each([
  ["42501", 403],
  ["PT409", 409],
])("reports a native %s denial", async (code, status) => {
  rpc.mockResolvedValue({ data: null, error: { code } });
  expect((await POST(action(), params)).status).toBe(status);
});

it("reports unavailable execution authority without exposing database details", async () => {
  rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Revoked grant 42" } });
  const response = await POST(
    action({ requestId, expectedGeneration: 3, action: "resume" }),
    params,
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "Workflow access or execution authority is unavailable.",
  });
});
