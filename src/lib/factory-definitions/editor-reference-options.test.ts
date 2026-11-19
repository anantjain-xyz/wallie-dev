import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { loadFactoryEditorReferenceOptions } from "./editor-reference-options";

it("returns only scoped, approved revision suggestions and operation names", async () => {
  const requests: URL[] = [];
  const client = createClient<Database>("https://database.example.test", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        requests.push(url);
        if (url.pathname.endsWith("/factory_skill_revisions")) {
          expect(url.searchParams.get("select")).toBe(
            "id,revision_number,factory_skills!inner(name)",
          );
          return Response.json([
            { id: "skill", revision_number: 3, factory_skills: { name: "Search" } },
          ]);
        }
        expect(url.pathname).toMatch(/\/factory_mcp_server_revisions$/);
        expect(url.searchParams.get("select")).toBe(
          "id,revision_number,operation_names,factory_mcp_servers!inner(name)",
        );
        return Response.json([
          {
            id: "tool",
            revision_number: 4,
            operation_names: ["read", "write"],
            factory_mcp_servers: { name: "Catalog" },
          },
        ]);
      },
    },
  });

  await expect(loadFactoryEditorReferenceOptions(client, "workspace", "factory")).resolves.toEqual({
    skills: [{ id: "skill", label: "Search · Revision 3" }],
    tools: [{ id: "tool", label: "Catalog · Revision 4", operations: ["read", "write"] }],
  });
  expect(requests).toHaveLength(2);
  for (const { searchParams } of requests) {
    expect(searchParams.get("workspace_id")).toBe("eq.workspace");
    expect(searchParams.get("factory_id")).toBe("eq.factory");
    expect(searchParams.get("revoked_at")).toBe("is.null");
    expect(searchParams.get("limit")).toBe("100");
  }
});
