import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocked.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocked.admin }));

import { GET, POST } from "./route";
import { POST as savePrompt } from "./[agentId]/prompt-revisions/route";

const workspaceId = "55210000-0000-4000-8000-000000000001";
const factoryId = "55210000-0000-4000-8000-000000000002";
const agentId = "55210000-0000-4000-8000-000000000003";
const userId = "55210000-0000-4000-8000-000000000004";
const params = Promise.resolve({ workspaceId, factoryId });

function fixture({ visible = true, errorCode }: { visible?: boolean; errorCode?: string } = {}) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/factories"))
      return Response.json(visible ? { id: factoryId } : null);
    if (url.pathname.endsWith("/factory_agents"))
      return Response.json([{ id: agentId, name: "Release" }]);
    if (errorCode) return Response.json({ code: errorCode, message: "Rejected" }, { status: 400 });
    return Response.json({ id: agentId, revision_number: 2 });
  });
  const client = createClient<Database>("http://factory.test", "fixture", {
    global: { fetch: fetcher },
  });
  mocked.access.mockResolvedValue({
    ok: true,
    context: { user: { id: userId }, supabase: client },
  });
  mocked.admin.mockReturnValue(client);
  return fetcher;
}

function request(body: unknown) {
  return new Request("http://localhost/api/agents", { method: "POST", body: JSON.stringify(body) });
}

describe("factory agent routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns only the RLS-visible factory list and prevents cache reuse", async () => {
    fixture();
    const result = await GET(new Request("http://localhost/api/agents"), { params });
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result.json()).toMatchObject({ agents: [{ id: agentId, name: "Release" }] });
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("does not use privileged writes when the factory is hidden", async () => {
    fixture({ visible: false });
    const result = await POST(request({ name: "Release", slug: "release" }), { params });
    expect(result.status).toBe(404);
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("requires workspace authentication before reading factory identities", async () => {
    mocked.access.mockResolvedValue({ ok: false, error: "Sign in required.", status: 401 });
    const result = await GET(new Request("http://localhost/api/agents"), { params });
    expect(result.status).toBe(401);
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("preserves the database manager gate and rejects declared authority", async () => {
    fixture({ errorCode: "42501" });
    expect(
      (await POST(request({ name: "Release", slug: "release", promptMd: "Rules" }), { params }))
        .status,
    ).toBe(403);
    mocked.admin.mockClear();
    expect(
      (await POST(request({ name: "Release", slug: "release", authority: "owner" }), { params }))
        .status,
    ).toBe(400);
    expect(mocked.admin).not.toHaveBeenCalled();
  });

  it("returns a conflict when a prompt editor submits an old revision", async () => {
    fixture({ errorCode: "PT409" });
    const result = await savePrompt(request({ expectedRevisionNumber: 1, promptMd: "Candidate" }), {
      params: Promise.resolve({ workspaceId, factoryId, agentId }),
    });
    expect(result.status).toBe(409);
  });
});
