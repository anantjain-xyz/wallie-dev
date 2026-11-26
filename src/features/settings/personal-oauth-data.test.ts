import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { loadPersonalOAuthConnections } from "@/features/settings/personal-oauth-data";
import type { Database } from "@/lib/supabase/database.types";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const cursorId = "00000000-0000-4000-8000-000000000003";
const createdAt = "2026-05-01T10:00:00.123456+00:00";
const expiresAt = "2026-05-31T10:00:00+00:00";
const grant = {
  id: cursorId,
  created_at: createdAt,
  expires_at: expiresAt,
  revoked_at: null,
  scopes: ["sessions:read"],
  factory_oauth_clients: null,
  factory_oauth_grant_bindings: [{ factory_id: "factory-1", scopes: ["sessions:read"] }],
};

function setup() {
  const fetch = vi.fn<(url: string) => Promise<Response>>();
  const supabase = createClient<Database>("https://supabase.example.test", "mock-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
  return { fetch, supabase };
}

describe("workspace personal OAuth connections", () => {
  it("only requests the current member's active grants, newest first, with exact cursor ties", async () => {
    const { fetch, supabase } = setup();
    fetch
      .mockResolvedValueOnce(Response.json([grant]))
      .mockResolvedValueOnce(Response.json([grant]))
      .mockResolvedValueOnce(Response.json([{ id: "factory-1", name: "Docs Factory" }]));

    const result = await loadPersonalOAuthConnections({
      afterGrantId: cursorId,
      history: false,
      memberId,
      supabase,
      workspaceId,
    });

    const [cursorQuery, pageQuery, factoryQuery] = fetch.mock.calls.map(
      ([url]) => new URL(url).searchParams,
    );
    for (const query of [cursorQuery, pageQuery]) {
      expect(query.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(query.get("consenting_member_id")).toBe(`eq.${memberId}`);
    }
    expect(cursorQuery.get("id")).toBe(`eq.${cursorId}`);
    expect(pageQuery.get("order")).toBe("created_at.desc,id.desc");
    expect(pageQuery.get("revoked_at")).toBe("is.null");
    expect(pageQuery.get("expires_at")).toMatch(/^gt\./);
    expect(pageQuery.get("or")).toBe(
      `(created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${cursorId}))`,
    );
    expect(factoryQuery.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(factoryQuery.get("id")).toBe("in.(factory-1)");
    expect(result.grants).toMatchObject([
      {
        status: "Active",
        clientName: "Client name unavailable",
        connectedAt: createdAt,
        factories: [{ name: "Docs Factory", scopes: ["sessions:read"] }],
      },
    ]);
  });

  it("paginates expired and disconnected grants separately from active connections", async () => {
    const { fetch, supabase } = setup();
    fetch.mockResolvedValueOnce(
      Response.json(
        Array.from({ length: 21 }, (_, i) => ({
          ...grant,
          id: `grant-${i}`,
          revoked_at: i === 0 ? expiresAt : null,
          factory_oauth_clients: { name: "Publishing client" },
          factory_oauth_grant_bindings: [],
        })),
      ),
    );
    const result = await loadPersonalOAuthConnections({
      history: true,
      memberId,
      supabase,
      workspaceId,
    });

    const query = new URL(fetch.mock.calls[0][0]).searchParams;
    expect(query.get("or")).toMatch(/^\(revoked_at.not.is.null,expires_at.lte\..*\)$/);
    expect(query.get("order")).toBe("created_at.desc,id.desc");
    expect(query.get("limit")).toBe("21");
    expect(result.grants[0]).toMatchObject({
      clientName: "Publishing client",
      status: "Disconnected",
    });
    expect(result.grants[1].status).toBe("Expired");
    expect(result.grants).toHaveLength(20);
    expect(result.next).toBe("grant-19");
  });
});
