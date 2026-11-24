import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "./route";

const mock = vi.hoisted(() => ({
  context: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/factories/route-context", () => ({
  factoryResponseHeaders: { "Cache-Control": "private, no-store" },
  resolveFactoryRouteContext: mock.context,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mock.rpc }) }));

const workspaceId = "67300000-0000-4000-8000-000000000001";
const factoryId = "67300000-0000-4000-8000-000000000002";
const resourceId = "67300000-0000-4000-8000-000000000003";
const userId = "67300000-0000-4000-8000-000000000004";
const teamId = "67300000-0000-4000-8000-000000000005";
const fromStateId = "67300000-0000-4000-8000-000000000006";
const toStateId = "67300000-0000-4000-8000-000000000007";
const scope = {
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_resource_id: resourceId,
  p_actor_user_id: userId,
};
const context = {
  params: Promise.resolve({ workspaceId, factoryId, resourceId }),
};
const operator = {
  ok: true,
  workspaceId,
  factoryId,
  access: { user: { id: userId }, currentMember: { role: "owner" } },
};
const input = {
  expectedRevision: 2,
  mappingRevision: 3,
  commentsEnabled: true,
  statusMapping: { teamId, fromStateId, toStateId },
};

function writeRequest(body: unknown = input) {
  return new Request("https://wallie.example.test/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Linear outbound configuration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.context.mockResolvedValue(operator);
    mock.rpc.mockResolvedValue({ data: 3, error: null });
  });

  it("writes exact mapping and policy revisions as the current workspace operator", async () => {
    const response = await PUT(writeRequest(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 3 });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("configure_linear_connector_outbound", {
      ...scope,
      p_expected_revision: 2,
      p_expected_mapping_revision: 3,
      p_comments_enabled: true,
      p_status_team_id: teamId,
      p_status_from_state_id: fromStateId,
      p_status_to_state_id: toStateId,
    });
  });

  it("supports explicitly switching off comments and status writes", async () => {
    const response = await PUT(
      writeRequest({ ...input, commentsEnabled: false, statusMapping: null }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("configure_linear_connector_outbound", {
      ...scope,
      p_expected_revision: 2,
      p_expected_mapping_revision: 3,
      p_comments_enabled: false,
    });
  });

  it("rejects a member or an incomplete status mapping before a privileged write", async () => {
    mock.context.mockResolvedValueOnce({
      ...operator,
      access: { ...operator.access, currentMember: { role: "member" } },
    });
    expect((await PUT(writeRequest(), context)).status).toBe(403);
    expect(
      (await PUT(writeRequest({ ...input, statusMapping: { fromStateId } }), context)).status,
    ).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("uses the authenticated actor for configuration reads and denies server-only fields", async () => {
    const data = { revision: 2, mappingRevision: 3, commentsEnabled: false, statusMapping: null };
    mock.rpc.mockResolvedValueOnce({ data, error: null });
    const request = new Request("https://wallie.example.test");

    const response = await GET(request, context);

    expect(await response.json()).toEqual(data);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith(
      "read_linear_connector_outbound_config",
      scope,
    );

    mock.rpc.mockResolvedValueOnce({ data: { ...data, encryptedKey: "hidden" }, error: null });
    expect((await GET(request, context)).status).toBe(500);
  });

  it("returns a conflict for a stale resource or policy revision", async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: "PT409" } });

    expect((await PUT(writeRequest(), context)).status).toBe(409);
  });
});
