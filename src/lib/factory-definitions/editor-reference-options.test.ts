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
          if (exact) expect(url.searchParams.get("id")).toBe(`in.(${id(3)})`);
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
  const rawTools = await loadNamedFactoryReferences(client, workspace, factory, {
    mode: "more",
    kind: "tools",
    offset: 40,
  });
  expect(JSON.stringify(rawTools)).not.toContain("/internal-path");
  const tools = namedReferencesResponseSchema.parse(rawTools);
  expect(tools.groups.tools?.options).toMatchObject([
    {
      id: id(6),
      label: "Catalog · Revision 4 · tools.example.test",
      operations: ["read", "write"],
    },
  ]);
  expect(requests).toHaveLength(4);
  for (const { searchParams } of requests) {
    expect(searchParams.get("workspace_id")).toBe(`eq.${workspace}`);
    expect(searchParams.get("factory_id")).toBe(`eq.${factory}`);
  }
});

it.each([false, true])(
  "pages frozen candidate rows in key order (failed next page: %s)",
  async (failed) => {
    const offsets: number[] = [];
    const revisionFilters: string[] = [];
    const rows = Array.from({ length: 251 }, (_, i) => ({
      experiment_id: id(10 + Math.floor(i / 100)),
      candidate_key: i.toString(16).padStart(64, "0"),
      definition_revision_id: id(1_000 + i),
    }));
    const client = createClient<Database>("https://database.example.test", "test-key", {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: async (input) => {
          const { pathname, searchParams: params } = new URL(
            input instanceof Request ? input.url : input,
          );
          if (pathname.endsWith("/factory_benchmark_experiments")) {
            return Response.json(
              [id(10), id(11), id(12)].map((id) => ({ id, suite_revision_id: id })),
            );
          }
          if (pathname.endsWith("/factory_benchmark_experiment_candidates")) {
            expect(params.get("order")).toBe("experiment_id.asc,candidate_key.asc");
            expect(params.get("limit")).toBe("250");
            const offset = Number(params.get("offset"));
            offsets.push(offset);
            if (failed && offset)
              return Response.json({ message: "Candidate lookup failed." }, { status: 500 });
            return Response.json(rows.slice(offset, offset + 250));
          }
          if (pathname.endsWith("/factory_benchmark_evaluation_dimensions")) {
            expect(params.get("order")).toBe("experiment_id.asc,scorer_revision_id.asc");
          }
          if (pathname.endsWith("/factory_definition_revisions")) {
            revisionFilters.push(params.get("id") ?? "");
          }
          return Response.json([]);
        },
      },
    });
    const lookup = loadNamedFactoryReferences(client, workspace, factory, {
      mode: "pins",
      ids: { routing: [id(10), id(11), id(12)] },
    });
    if (failed) {
      await expect(lookup).rejects.toMatchObject({ message: "Candidate lookup failed." });
      expect(revisionFilters).toEqual([]);
    } else {
      await lookup;
      expect(revisionFilters.join(",")).toContain(id(1_250));
    }
    expect(offsets).toEqual([0, 250]);
  },
);
