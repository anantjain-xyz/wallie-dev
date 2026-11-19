import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import { loadOAuthClientData } from "@/features/factory-governance/governance-oauth-data";
import type { Database } from "@/lib/supabase/database.types";

it("loads only the viewer's personal grants and the clients linked to those grants", async () => {
  const requests: URL[] = [];
  const supabase = createClient<Database>("https://oauth.example.test", "viewer-fixture", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer viewer-fixture");
        expect(url.searchParams.get("workspace_id")).toBe("eq.workspace");
        const resource = url.pathname.split("/").at(-1);
        switch (resource) {
          case "factory_oauth_grants":
            expect(url.searchParams.get("consenting_member_id")).toBe("eq.current-member");
            return Response.json([
              { id: "grant", client_id: "own-client", consenting_member_id: "current-member" },
            ]);
          case "factories":
            return Response.json([{ id: "factory", name: "Customer tools", status: "active" }]);
          case "factory_oauth_grant_bindings":
            expect(url.searchParams.get("grant_id")).toBe("in.(grant)");
            return Response.json([
              { grant_id: "grant", factory_id: "factory", scopes: ["sessions:read"] },
            ]);
          case "factory_oauth_clients":
            expect(url.searchParams.get("id")).toBe("in.(own-client)");
            return Response.json([{ id: "own-client", name: "Release tools", revoked_at: null }]);
          default:
            throw new Error(`Unexpected personal connection resource ${resource}`);
        }
      },
    },
  });

  const data = await loadOAuthClientData(
    { supabase, workspaceId: "workspace" },
    { consentingMemberId: "current-member" },
  );
  expect(requests).toHaveLength(4);
  expect(data.registered).toEqual([]);
  expect(data.grantOptions).toEqual([]);
  expect(data.connected).toEqual([
    expect.objectContaining({
      id: "grant",
      client: { id: "own-client", name: "Release tools", revoked_at: null },
      factories: [{ id: "factory", name: "Customer tools", scopes: ["sessions:read"] }],
    }),
  ]);
});
