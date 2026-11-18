import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocked.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocked.admin }));

import { GET as listPrincipals, POST as createPrincipal } from "../service-principals/route";
import { GET, POST } from "./route";

const workspaceId = "55500000-0000-4000-8000-000000000001";
const factoryId = "55500000-0000-4000-8000-000000000002";
const actorUserId = "55500000-0000-4000-8000-000000000003";
const principalId = "55500000-0000-4000-8000-000000000004";
const writerId = "55500000-0000-4000-8000-000000000005";
const readContextId = "55500000-0000-4000-8000-000000000006";
const policyId = "55500000-0000-4000-8000-000000000007";
const payerMemberId = "55500000-0000-4000-8000-000000000008";
const grantId = "55500000-0000-4000-8000-000000000009";
const laterGrantId = "55500000-0000-4000-8000-000000000010";
const expiresAt = "2030-01-01T00:00:00Z";
const params = Promise.resolve({ workspaceId, factoryId });

const authority = {
  budgetPayerMemberId: payerMemberId,
  executionPolicyRevisionId: policyId,
  expiresAt,
  readContextRepositoryIds: [readContextId],
  servicePrincipalId: principalId,
  toolIds: ["reference-lookup"],
  writableRepositoryId: writerId,
};

const actorScope = {
  p_actor_user_id: actorUserId,
  p_factory_id: factoryId,
  p_workspace_id: workspaceId,
};

function fixture({ visible = true, errorCode }: { visible?: boolean; errorCode?: string } = {}) {
  const reads: URL[] = [];
  const writes: Array<{ rpc: string; body: unknown }> = [];
  const client = createClient<Database>("http://fixture.test", "viewer", {
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        reads.push(url);
        if (url.pathname.endsWith("/factories"))
          return Response.json(visible ? { id: factoryId } : null);
        if (url.pathname.endsWith("/service_principals")) {
          return Response.json([{ id: principalId, name: "Release agent" }]);
        }
        if (url.pathname.endsWith("/factory_execution_grants")) {
          return Response.json([
            { id: grantId, version: 1 },
            { id: laterGrantId, version: 1 },
          ]);
        }
        throw new Error(`Unexpected read endpoint ${url.pathname}`);
      },
    },
  });
  const admin = createClient<Database>("http://fixture.test", "server", {
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const rpc = url.pathname.split("/").at(-1) ?? "";
        const body: unknown = init?.body && JSON.parse(String(init.body));
        writes.push({ rpc, body });
        if (errorCode)
          return Response.json({ code: errorCode, message: "private SQL detail" }, { status: 400 });
        return Response.json(
          rpc === "create_service_principal" ? { id: principalId } : { id: grantId },
        );
      },
    },
  });
  mocked.access.mockResolvedValue({
    ok: true,
    context: { user: { id: actorUserId }, supabase: client },
  });
  mocked.admin.mockReturnValue(admin);
  return { reads, writes };
}

function post(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/execution-authority", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

describe("factory execution authority routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads bounded pages through the authenticated client with both scopes", async () => {
    const { reads } = fixture();
    const request = new Request(
      `http://localhost/api/execution-authority?limit=1&afterId=${actorUserId}`,
    );
    const grants = await GET(request, { params });
    const principals = await listPrincipals(request, { params });
    expect(grants.status).toBe(200);
    expect(grants.headers.get("cache-control")).toBe("private, no-store");
    expect(await grants.json()).toEqual({
      grants: [{ id: grantId, version: 1 }],
      nextAfterId: grantId,
    });
    expect(await principals.json()).toEqual({
      principals: [{ id: principalId, name: "Release agent" }],
      nextAfterId: null,
    });
    for (const url of reads.filter(({ pathname }) => !pathname.endsWith("/factories"))) {
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
      expect(url.searchParams.get("id")).toBe(`gt.${actorUserId}`);
      expect(url.searchParams.get("limit")).toBe("2");
    }
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("blocks unauthenticated callers and hidden factories before privileged access", async () => {
    mocked.access.mockResolvedValue({ ok: false, status: 401, error: "Sign in." });
    expect((await POST(post({ action: "approve", ...authority }), { params })).status).toBe(401);
    fixture({ visible: false });
    expect(
      (await createPrincipal(post({ name: "Release agent", slug: "release-agent" }), { params }))
        .status,
    ).toBe(404);
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("registers a service principal with the authenticated human and URL scope", async () => {
    const { writes } = fixture();
    const result = await createPrincipal(post({ name: "Release agent", slug: "release-agent" }), {
      params,
    });
    expect(result.status).toBe(201);
    expect(writes).toEqual([
      {
        rpc: "create_service_principal",
        body: { ...actorScope, p_name: "Release agent", p_slug: "release-agent" },
      },
    ]);
  });

  it("requires JSON for cookie-authenticated grant and principal mutations", async () => {
    fixture();
    expect(
      (await POST(post({ action: "approve", ...authority }, "text/plain"), { params })).status,
    ).toBe(415);
    expect(
      (
        await createPrincipal(
          post({ name: "Release agent", slug: "release-agent" }, "text/plain"),
          { params },
        )
      ).status,
    ).toBe(415);
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("rejects caller-selected actors, credentials, and missing compare-and-swap versions", async () => {
    fixture();
    const suppliedPrincipal = {
      name: "Release agent",
      slug: "release-agent",
      credential: "foreign-secret",
    };
    expect((await createPrincipal(post(suppliedPrincipal), { params })).status).toBe(400);
    expect(
      (await POST(post({ action: "approve", ...authority, actorUserId }), { params })).status,
    ).toBe(400);
    expect((await POST(post({ action: "update", grantId, ...authority }), { params })).status).toBe(
      400,
    );
    expect(
      (await POST(post({ action: "revoke", grantId, expectedVersion: 0 }), { params })).status,
    ).toBe(400);
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("passes exact approved resources, expected versions, and revoke reasons to SQL", async () => {
    const { writes } = fixture();
    expect((await POST(post({ action: "approve", ...authority }), { params })).status).toBe(201);
    expect(
      (
        await POST(post({ action: "update", grantId, expectedVersion: 3, ...authority }), {
          params,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await POST(
          post({ action: "revoke", grantId, expectedVersion: 4, reason: "No longer needed" }),
          { params },
        )
      ).status,
    ).toBe(200);
    const approvedScope = {
      ...actorScope,
      p_service_principal_id: principalId,
      p_github_repository_id: writerId,
      p_read_context_repository_ids: [readContextId],
      p_tool_ids: ["reference-lookup"],
      p_execution_policy_revision_id: policyId,
      p_budget_payer_member_id: payerMemberId,
      p_expires_at: expiresAt,
    };
    expect(writes).toEqual([
      { rpc: "approve_factory_execution_grant", body: { ...approvedScope, p_expected_version: 0 } },
      {
        rpc: "approve_factory_execution_grant",
        body: { ...approvedScope, p_expected_version: 3, p_grant_id: grantId },
      },
      {
        rpc: "revoke_factory_execution_grant",
        body: {
          ...actorScope,
          p_grant_id: grantId,
          p_expected_version: 4,
          p_reason: "No longer needed",
        },
      },
    ]);
  });

  it.each([
    ["42501", 403],
    ["PT409", 409],
  ])("preserves the database denial %s", async (errorCode, status) => {
    fixture({ errorCode });
    const result = await POST(
      post({ action: "update", grantId, expectedVersion: 1, ...authority }),
      { params },
    );
    expect(result.status).toBe(status);
    expect(await result.text()).not.toContain("private SQL detail");
  });
});
