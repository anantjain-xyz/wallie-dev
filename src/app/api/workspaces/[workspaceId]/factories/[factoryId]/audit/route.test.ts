import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

import { GET } from "./route";

vi.mock("@/lib/workspaces/access");

const workspaceId = "56200000-0000-4000-8000-000000000001";
const factoryId = "56200000-0000-4000-8000-000000000002";
const memberId = "56200000-0000-4000-8000-000000000003";
const routeUrl = `http://localhost/api/workspaces/${workspaceId}/factories/${factoryId}/audit`;

type Options = {
  factoryVisible?: boolean;
  factoryRole?: "manager" | "member" | null;
  workspaceRole?: Database["public"]["Enums"]["member_role"];
};

function fixture({
  factoryVisible = true,
  factoryRole = null,
  workspaceRole = "member",
}: Options = {}) {
  const requests: URL[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    switch (url.pathname) {
      case "/rest/v1/factories":
        return Response.json(factoryVisible ? [{ id: factoryId }] : []);
      case "/rest/v1/factory_members":
        return Response.json(factoryRole ? [{ role: factoryRole }] : []);
      case "/rest/v1/factory_audit_events":
        return Response.json([]);
      default:
        return Response.json({ message: "Unexpected query" }, { status: 500 });
    }
  });
  const supabase = createClient<Database>("http://factory-audit.test", "fixture", {
    auth: { persistSession: false },
    global: { fetch },
  });
  vi.mocked(requireWorkspaceAccessById).mockResolvedValue({
    ok: true,
    context: {
      currentMember: { id: memberId, role: workspaceRole, is_active: true, kind: "human" },
      supabase,
      user: { id: memberId },
      workspace: { id: workspaceId, slug: "fixture", name: "Fixture", avatar_path: null },
    },
  });
  return requests;
}

function get(query = "") {
  return GET(new Request(`${routeUrl}${query}`), {
    params: Promise.resolve({ workspaceId, factoryId }),
  });
}

describe("factory audit route", () => {
  it("returns a permitted empty history with a bounded page and private cache controls", async () => {
    const requests = fixture({ workspaceRole: "owner" });
    const response = await get("?limit=3");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [], nextCursor: null });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requests.map((url) => url.pathname)).toEqual([
      "/rest/v1/factories",
      "/rest/v1/factory_audit_events",
    ]);
    expect(requests[1].searchParams.get("limit")).toBe("4");
  });

  it("requires the exact active factory manager role for non-operator members", async () => {
    const requests = fixture({ factoryRole: "manager" });
    const response = await get("?facet=governance&sourceKind=event&sourceId=9007199254740993");
    expect(response.status).toBe(200);
    expect(requests[1].pathname).toBe("/rest/v1/factory_members");
    expect(requests[1].searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(requests[1].searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(requests[1].searchParams.get("member_id")).toBe(`eq.${memberId}`);
    expect(requests[1].searchParams.get("revoked_at")).toBe("is.null");
    expect(requests[2].searchParams.get("id")).toBe("eq.9007199254740993");
  });

  it.each(["member", null] as const)(
    "returns forbidden for a visible factory with membership role %s",
    async (factoryRole) => {
      const requests = fixture({ factoryRole });
      expect((await get()).status).toBe(403);
      expect(requests.map((url) => url.pathname)).toEqual([
        "/rest/v1/factories",
        "/rest/v1/factory_members",
      ]);
    },
  );

  it("reports a missing or inaccessible exact factory distinctly from an empty audit", async () => {
    const requests = fixture({ factoryVisible: false });
    expect((await get()).status).toBe(404);
    expect(requests.map((url) => url.pathname)).toEqual(["/rest/v1/factories"]);
  });

  it.each([
    "?limit=101",
    "?sourceKind=grant",
    "?sourceId=1",
    "?sourceKind=event&sourceId=9223372036854775808",
    "?sourceKind=event&sourceId=unexpected",
    "?facet=unexpected",
  ])("rejects invalid query %s before fetching resources", async (query) => {
    const requests = fixture();
    expect((await get(query)).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("reports an invalid continuation token as a bad request", async () => {
    const requests = fixture({ workspaceRole: "admin" });
    expect((await get("?cursor=notBase64Json")).status).toBe(400);
    expect(requests.map((url) => url.pathname)).toEqual(["/rest/v1/factories"]);
  });
});
