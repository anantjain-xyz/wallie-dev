import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { loadNamedFactoryReferences } from "./named-reference-catalog";
import { namedReferencesResponseSchema } from "./named-reference-contracts";

const id = (suffix: number) => `54600000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const workspace = id(1);
const factory = id(2);

it("loads approved suggestions and separately resolves exact out-of-page pins in the same scope", async () => {
  const requests: URL[] = [];
  const client = createClient<Database>("https://database.example.test", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        requests.push(url);
        if (url.pathname.endsWith("/factory_skill_revisions")) {
          const exact = url.searchParams.has("id");
          expect(url.searchParams.get("revoked_at")).toBe(exact ? null : "is.null");
          return Response.json([
            {
              id: exact ? id(3) : id(4),
              revision_number: exact ? 1 : 3,
              revoked_at: exact ? "2026-11-25" : null,
              factory_skills: { name: "Search" },
            },
          ]);
        }
        if (url.pathname.endsWith("/factory_scorer_revisions")) {
          expect(url.searchParams.get("id")).toBe(`in.(${id(5)})`);
          return Response.json([
            { id: id(5), revision_number: 1, factory_scorers: { name: "Verification" } },
          ]);
        }
        expect(url.pathname).toMatch(/\/factory_mcp_server_revisions$/);
        expect(url.searchParams.get("revoked_at")).toBe("is.null");
        return Response.json([
          {
            id: id(6),
            revision_number: 4,
            operation_names: ["read", "write"],
            auth_kind: "none",
            endpoint: "https://tools.example.test/internal-path",
            factory_mcp_servers: { name: "Catalog" },
          },
        ]);
      },
    },
  });

  const skills = namedReferencesResponseSchema.parse(
    await loadNamedFactoryReferences(client, workspace, factory, {
      mode: "more",
      kind: "skills",
      offset: 40,
    }),
  );
  expect(skills.groups.skills?.options).toMatchObject([
    { id: id(4), label: "Search · Revision 3", unavailable: false },
  ]);
  const pins = namedReferencesResponseSchema.parse(
    await loadNamedFactoryReferences(client, workspace, factory, {
      mode: "pins",
      ids: { skills: [id(3)], scorers: [id(5)] },
    }),
  );
  expect(pins.groups.skills?.options).toMatchObject([
    { id: id(3), label: "Search · Revision 1", unavailable: true },
  ]);
  expect(pins.groups.scorers?.options).toMatchObject([
    { id: id(5), label: "Verification · Revision 1" },
  ]);
  const tools = namedReferencesResponseSchema.parse(
    await loadNamedFactoryReferences(client, workspace, factory, {
      mode: "more",
      kind: "tools",
      offset: 40,
    }),
  );
  expect(tools.groups.tools?.options).toMatchObject([
    {
      id: id(6),
      label: "Catalog · Revision 4 · tools.example.test",
      operations: ["read", "write"],
    },
  ]);
  expect(JSON.stringify(tools)).not.toContain("/internal-path");
  expect(requests).toHaveLength(4);
  for (const { searchParams } of requests) {
    expect(searchParams.get("workspace_id")).toBe(`eq.${workspace}`);
    expect(searchParams.get("factory_id")).toBe(`eq.${factory}`);
  }
});
