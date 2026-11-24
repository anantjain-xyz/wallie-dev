import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "./route";

const mock = vi.hoisted(() => ({
  context: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@/lib/factories/route-context", () => ({
  factoryResponseHeaders: { "Cache-Control": "no-store" },
  resolveFactoryRouteContext: mock.context,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mock.write }) }));

const workspaceId = "67200000-0000-4000-8000-000000000001";
const factoryId = "67200000-0000-4000-8000-000000000002";
const resourceId = "67200000-0000-4000-8000-000000000003";
const userId = "67200000-0000-4000-8000-000000000004";
const stateId = "67200000-0000-4000-8000-000000000005";
const path = {
  params: Promise.resolve({ workspaceId, factoryId, resourceId }),
};

const access = {
  user: { id: userId },
  currentMember: { role: "owner" },
  supabase: { rpc: mock.read },
};

function writeRequest() {
  return new Request("https://wallie.example.test/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: 0,
      mappingRevision: 1,
      enabled: true,
      stateIds: [stateId],
    }),
  });
}

describe("Linear discovery configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.context.mockResolvedValue({ ok: true, workspaceId, factoryId, access });
    mock.write.mockResolvedValue({ data: 1, error: null });
  });

  it("writes the exact authenticated operator and mapped resource", async () => {
    const response = await PUT(writeRequest(), path);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 1 });
    expect(mock.write).toHaveBeenCalledExactlyOnceWith("configure_linear_issue_discovery", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_actor_user_id: userId,
      p_resource_id: resourceId,
      p_expected_revision: 0,
      p_expected_mapping_revision: 1,
      p_state_ids: [stateId],
      p_enabled: true,
    });
  });

  it("rejects a non-operator before a privileged configuration call", async () => {
    mock.context.mockResolvedValue({
      ok: true,
      workspaceId,
      factoryId,
      access: { ...access, currentMember: { role: "member" } },
    });

    expect((await PUT(writeRequest(), path)).status).toBe(403);
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("reads configuration using the caller's authenticated database client", async () => {
    const configuration = {
      revision: 1,
      mappingRevision: 1,
      enabled: true,
      stateIds: [stateId],
      labelId: null,
      serviceActorId: null,
    };
    mock.read.mockResolvedValue({ data: configuration, error: null });

    const response = await GET(new Request("https://wallie.example.test/"), path);

    expect(await response.json()).toEqual(configuration);
    expect(mock.read).toHaveBeenCalledExactlyOnceWith("read_linear_issue_discovery_config", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_resource_id: resourceId,
    });
    expect(mock.write).not.toHaveBeenCalled();
  });
});
