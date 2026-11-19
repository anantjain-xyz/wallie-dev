import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocked.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocked.admin }));

import { GET, POST } from "./route";

const id = (n: number) => `55700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [workspaceId, factoryId, actorId, serverId, revisionId, otherRevisionId, bindingId] = [
  id(1),
  id(2),
  id(3),
  id(4),
  id(5),
  id(6),
  id(7),
];
const params = Promise.resolve({ workspaceId, factoryId });
const metadata = {
  endpoint: "https://approved.example.test/mcp",
  operationNames: ["list_items", "read_item"],
  authKind: "bearer",
};
const revisionRow = {
  id: revisionId,
  server_id: serverId,
  revision_number: 2,
  endpoint: metadata.endpoint,
  operation_names: metadata.operationNames,
  auth_kind: metadata.authKind,
  revoked_at: null,
  created_at: "2026-11-18T00:00:00Z",
  server: { name: "Inventory", slug: "inventory" },
  rawCredential: "must-not-serialize",
};
const bindingRow = {
  id: bindingId,
  execution_grant_id: id(8),
  factory_agent_id: id(9),
  service_principal_id: id(10),
  tool_revision_id: revisionId,
  revoked_at: null,
  created_at: "2026-11-18T00:00:00Z",
  workspace_secret_id: id(11),
  encrypted_value: "must-not-serialize",
};

function setup({ visible = true, errorCode }: { visible?: boolean; errorCode?: string } = {}) {
  const reads: URL[] = [];
  const calls: Array<{ name: string; body: unknown }> = [];
  const viewer = createClient<Database>("http://fixture.test", "viewer", {
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        reads.push(url);
        switch (url.pathname.split("/").at(-1)) {
          case "factories":
            return Response.json(visible ? { id: factoryId } : null);
          case "factory_mcp_server_revisions":
            return Response.json([revisionRow, { ...revisionRow, id: otherRevisionId }]);
          case "factory_mcp_secret_bindings":
            return Response.json([bindingRow]);
          default:
            throw new Error("Unexpected authenticated read");
        }
      },
    },
  });
  const admin = createClient<Database>("http://fixture.test", "admin", {
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const name = url.pathname.split("/").at(-1) ?? "";
        const body: unknown = JSON.parse(String(init?.body));
        calls.push({ name, body });
        if (errorCode)
          return Response.json({ code: errorCode, message: "must-not-serialize" }, { status: 400 });
        if (name === "list_factory_bindable_workspace_secrets") {
          return Response.json([
            { id: id(11), key: "INVENTORY_TOKEN", value_preview: "must-not-serialize" },
          ]);
        }
        return Response.json(name.includes("secret_binding") ? bindingRow : revisionRow);
      },
    },
  });
  mocked.access.mockResolvedValue({
    ok: true,
    context: { user: { id: actorId }, supabase: viewer },
  });
  mocked.admin.mockReturnValue(admin);
  return { reads, calls };
}

function request(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/tools", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

const actorScope = {
  p_actor_user_id: actorId,
  p_factory_id: factoryId,
  p_workspace_id: workspaceId,
};

describe("factory MCP registry routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("registers reviewed metadata within the authenticated factory scope", async () => {
    const { calls } = setup();
    const response = await POST(
      request({ action: "register", name: "Inventory", slug: "inventory", ...metadata }),
      { params },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(calls).toEqual([
      {
        name: "create_factory_mcp_server",
        body: {
          ...actorScope,
          p_name: "Inventory",
          p_slug: "inventory",
          p_endpoint: metadata.endpoint,
          p_operation_names: metadata.operationNames,
          p_auth_kind: metadata.authKind,
        },
      },
    ]);
    expect(await response.text()).not.toContain("must-not-serialize");
  });

  it.each([
    "http://approved.example.test/mcp",
    "https://owner:synthetic-password@approved.example.test/mcp",
    "https://approved.example.test/mcp?token=synthetic",
    "https://approved.example.test/mcp#fragment",
  ])("rejects a non-approved endpoint shape %s before calling the mutation", async (endpoint) => {
    const { calls } = setup();
    const response = await POST(
      request({ action: "register", name: "Inventory", slug: "inventory", ...metadata, endpoint }),
      { params },
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("rejects raw credentials and invalid operations at the JSON boundary", async () => {
    const { calls } = setup();
    const input = { action: "register", name: "Inventory", slug: "inventory", ...metadata };
    for (const command of [
      { ...input, token: "must-not-serialize" },
      { ...input, operationNames: ["*"] },
      { ...input, operationNames: ["read", "read"] },
    ]) {
      expect((await POST(request(command), { params })).status).toBe(400);
    }
    expect((await POST(request(input, "text/plain"), { params })).status).toBe(415);
    expect(calls).toEqual([]);
  });

  it("lists exact revisions through the session-scoped client with bounded pagination", async () => {
    const { reads } = setup();
    const response = await GET(
      new Request(`http://localhost/api/tools?serverId=${serverId}&limit=1&afterId=${actorId}`),
      { params },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revisions: [
        {
          id: revisionId,
          serverId,
          revisionNumber: 2,
          ...metadata,
          revokedAt: null,
          createdAt: revisionRow.created_at,
          server: { name: "Inventory", slug: "inventory" },
        },
      ],
      nextAfterId: revisionId,
    });
    const query = reads.find(({ pathname }) =>
      pathname.endsWith("/factory_mcp_server_revisions"),
    )?.searchParams;
    expect(query?.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(query?.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(query?.get("server_id")).toBe(`eq.${serverId}`);
    expect(query?.get("id")).toBe(`gt.${actorId}`);
    expect(query?.get("limit")).toBe("2");
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("uses an exact revision compare-and-set and hides database error detail", async () => {
    const { calls } = setup({ errorCode: "PT409" });
    const response = await POST(
      request({ action: "revise", serverId, expectedRevisionNumber: 2, ...metadata }),
      { params },
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("must-not-serialize");
    expect(calls[0]).toMatchObject({
      name: "save_factory_mcp_server_revision",
      body: { ...actorScope, p_expected_revision_number: 2, p_server_id: serverId },
    });
  });

  it("delegates an opaque workspace secret and exposes only binding metadata", async () => {
    const { calls, reads } = setup();
    const response = await POST(
      request({
        action: "bind-secret",
        grantId: id(8),
        grantVersion: 2,
        agentId: id(9),
        toolRevisionId: revisionId,
        workspaceSecretId: id(11),
      }),
      { params },
    );
    expect(response.status).toBe(201);
    const { binding } = await response.json();
    expect(binding).toEqual({
      id: bindingId,
      grantId: id(8),
      agentId: id(9),
      servicePrincipalId: id(10),
      toolRevisionId: revisionId,
      revokedAt: null,
      createdAt: bindingRow.created_at,
    });
    expect(calls[0]).toEqual({
      name: "create_factory_mcp_secret_binding",
      body: {
        ...actorScope,
        p_execution_grant_id: id(8),
        p_execution_grant_version: 2,
        p_factory_agent_id: id(9),
        p_tool_revision_id: revisionId,
        p_workspace_secret_id: id(11),
      },
    });
    const inventory = await GET(
      new Request(`http://localhost/api/tools?resource=bindings&toolRevisionId=${revisionId}`),
      { params },
    );
    expect(await inventory.json()).toEqual({ bindings: [binding], nextAfterId: null });
    const query = reads.find(({ pathname }) =>
      pathname.endsWith("/factory_mcp_secret_bindings"),
    )?.searchParams;
    expect(query?.get("select")).not.toMatch(/workspace_secret_id|encrypted_value/);
    expect(query?.get("tool_revision_id")).toBe(`eq.${revisionId}`);
  });

  it("lists only eligible saved references through the owner-checked RPC", async () => {
    const { calls } = setup();
    const response = await GET(new Request("http://localhost/api/tools?resource=secrets"), {
      params,
    });
    expect(await response.json()).toEqual({ secrets: [{ id: id(11), key: "INVENTORY_TOKEN" }] });
    expect(calls).toEqual([{ name: "list_factory_bindable_workspace_secrets", body: actorScope }]);
  });

  it("honors factory visibility and rejects database manager denial", async () => {
    setup({ visible: false });
    expect(
      (await POST(request({ action: "revoke", serverId, revisionId }), { params })).status,
    ).toBe(404);
    expect(mocked.admin).not.toHaveBeenCalled();
    const { calls } = setup({ errorCode: "42501" });
    expect(
      (await POST(request({ action: "revoke", serverId, revisionId }), { params })).status,
    ).toBe(403);
    expect(calls[0]).toMatchObject({
      name: "revoke_factory_mcp_server_revision",
      body: { ...actorScope, p_server_id: serverId, p_revision_id: revisionId },
    });
  });
});
