import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  admin: vi.fn(),
  rpc: vi.fn(),
  grants: vi.fn(),
}));
vi.mock("@/lib/factories/route-context", () => ({
  factoryResponseHeaders: { "Cache-Control": "private, no-store" },
  resolveFactoryRouteContext: mocks.access,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { GET, POST } from "./route";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const grantId = id(3);
const agentId = id(4);
const bindingId = id(5);
const secretId = id(6);
const userId = id(7);
const context = { params: Promise.resolve({ workspaceId, factoryId }) };
const endpoint = `https://wallie.test/api/workspaces/${workspaceId}/factories/${factoryId}/secret-bindings`;
const query = new URLSearchParams({ grantId, agentId, provider: "codex", grantVersion: "2" });
const actor = { p_workspace_id: workspaceId, p_factory_id: factoryId, p_actor_user_id: userId };
const rotatedAt = "2026-11-18T20:00:00Z";
const rawBinding = {
  id: bindingId,
  workspace_id: workspaceId,
  factory_id: factoryId,
  execution_grant_id: grantId,
  service_principal_id: id(8),
  factory_agent_id: agentId,
  agent_provider: "codex",
  workspace_secret_id: secretId,
  version: 1,
  status: "ready",
  material_revision: 2,
  rotated_at: rotatedAt,
  secret_key: "AGENT_API_KEY",
  encrypted_value: "synthetic-ciphertext-sentinel",
  value_preview: "synthetic-preview-sentinel",
};
const attach = {
  action: "attach",
  grantId,
  agentId,
  provider: "codex",
  grantVersion: 2,
  workspaceSecretId: secretId,
};

function allow(role = "owner") {
  mocks.access.mockResolvedValue({
    ok: true,
    workspaceId,
    factoryId,
    access: { user: { id: userId }, currentMember: { role }, supabase: { from: mocks.grants } },
  });
}

function grant(version = 2) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      error: null,
      data: { version, revoked_at: null, expires_at: "2099-11-18T20:00:00Z" },
    }),
  };
  mocks.grants.mockReturnValue(builder);
  return builder;
}

function command(body: unknown, contentType = "application/json") {
  return new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  allow();
  mocks.admin.mockReturnValue({ rpc: mocks.rpc });
  grant();
});

describe("factory credential metadata", () => {
  it("filters to the exact scope and returns only readiness and rotation metadata", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        { ...rawBinding, id: id(9), factory_id: id(10) },
        { ...rawBinding, id: id(11), agent_provider: "cursor" },
        rawBinding,
      ],
      error: null,
    });
    const response = await GET(new Request(`${endpoint}?${query}`), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("list_factory_secret_bindings", actor);
    expect(await response.json()).toEqual({
      binding: {
        id: bindingId,
        version: 1,
        status: "ready",
        materialRevision: 2,
        rotatedAt,
        secretKey: "AGENT_API_KEY",
      },
      availableBinding: null,
      grantMatches: true,
      eligibleSecrets: [],
    });
  });

  it("reports when a definition pins a superseded execution grant version", async () => {
    grant(3);
    mocks.rpc.mockResolvedValue({ data: [rawBinding], error: null });
    const response = await GET(new Request(`${endpoint}?${query}&bindingId=${bindingId}`), context);
    expect(await response.json()).toMatchObject({
      binding: { id: bindingId, status: "grant_unavailable" },
      grantMatches: false,
      eligibleSecrets: [],
    });
  });

  it("lists only reference labels from eligible saved secrets and only for workspace managers", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({
      data: [{ id: secretId, key: "AGENT_API_KEY", value_preview: "synthetic-unsafe-preview" }],
      error: null,
    });
    const response = await GET(new Request(`${endpoint}?${query}`), context);
    expect(await response.json()).toEqual({
      binding: null,
      availableBinding: null,
      grantMatches: true,
      eligibleSecrets: [{ id: secretId, key: "AGENT_API_KEY" }],
    });

    allow("member");
    mocks.rpc.mockReset().mockResolvedValue({ data: [], error: null });
    const managerResponse = await GET(new Request(`${endpoint}?${query}`), context);
    expect(await managerResponse.json()).toMatchObject({ eligibleSecrets: [] });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("list_factory_secret_bindings", actor);
  });

  it("keeps the revoked pin visible when a replacement has been attached", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ ...rawBinding, id: id(10), status: "revoked" }, rawBinding],
      error: null,
    });
    const response = await GET(new Request(`${endpoint}?${query}&bindingId=${id(10)}`), context);
    expect(await response.json()).toMatchObject({
      binding: { id: id(10), status: "revoked" },
      availableBinding: { id: bindingId, status: "ready" },
    });
  });

  it("matches an OpenCode credential only to the requested upstream provider", async () => {
    const zen = { ...rawBinding, agent_provider: "opencode", open_code_provider_id: "opencode" };
    const router = { ...zen, id: id(10), open_code_provider_id: "openrouter" };
    mocks.rpc.mockResolvedValue({ data: [zen, router], error: null });
    const modelScope = new URLSearchParams(query);
    modelScope.set("provider", "opencode");
    modelScope.set("bindingId", zen.id);
    expect((await GET(new Request(`${endpoint}?${modelScope}`), context)).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();

    modelScope.set("openCodeProviderId", "openrouter");
    const response = await GET(new Request(`${endpoint}?${modelScope}`), context);
    expect(await response.json()).toMatchObject({
      binding: null,
      availableBinding: { id: router.id, status: "ready", openCodeProviderId: "openrouter" },
    });
  });
});

describe("factory credential mutations", () => {
  it("accepts only saved source references and returns the new binding identity", async () => {
    const select = vi
      .fn()
      .mockReturnValue({ single: vi.fn().mockResolvedValue({ data: rawBinding, error: null }) });
    mocks.rpc.mockReturnValue({ select });
    const response = await POST(command(attach), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: bindingId, version: 1 });
    expect(select).toHaveBeenCalledWith("id,version");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("create_factory_secret_binding", {
      ...actor,
      p_execution_grant_id: grantId,
      p_execution_grant_version: 2,
      p_factory_agent_id: agentId,
      p_agent_provider: "codex",
      p_workspace_secret_id: secretId,
    });
  });

  it("rejects plaintext fields and non-JSON attacks before using a privileged client", async () => {
    expect((await POST(command({ ...attach, value: "synthetic-value" }), context)).status).toBe(
      400,
    );
    expect((await POST(command(attach, "text/plain"), context)).status).toBe(415);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("requires and forwards the exact OpenCode provider when attaching a saved source", async () => {
    const input = { ...attach, provider: "opencode" };
    expect((await POST(command(input), context)).status).toBe(400);
    expect(
      (await POST(command({ ...input, openCodeProviderId: "opencode/models" }), context)).status,
    ).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.rpc.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: rawBinding, error: null }),
    });

    const response = await POST(command({ ...input, openCodeProviderId: "openrouter" }), context);
    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("create_factory_secret_binding", {
      ...actor,
      p_execution_grant_id: grantId,
      p_execution_grant_version: 2,
      p_factory_agent_id: agentId,
      p_agent_provider: "opencode",
      p_open_code_provider_id: "openrouter",
      p_workspace_secret_id: secretId,
    });
  });

  it("prevents factory members from claiming a workspace-owned source", async () => {
    allow("member");
    expect((await POST(command(attach), context)).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("uses expected-version revocation and keeps error details out of the response", async () => {
    const select = vi.fn().mockReturnValue({
      single: vi
        .fn()
        .mockResolvedValue({ data: null, error: { code: "PT409", message: "synthetic-error" } }),
    });
    mocks.rpc.mockReturnValue({ select });
    const response = await POST(
      command({ action: "revoke", bindingId, expectedVersion: 1 }),
      context,
    );
    expect(response.status).toBe(409);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("revoke_factory_secret_binding", {
      ...actor,
      p_binding_id: bindingId,
      p_expected_version: 1,
    });
    expect(await response.text()).not.toContain("synthetic-error");
  });
});
