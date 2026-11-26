import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { createFactoryScorerSchema } from "./authoring-contracts";
import { createFactoryScorer, readFactoryScorerRevision, searchFactoryScorers } from "./service";

const workspaceId = "60210000-0000-4000-8000-000000000001";
const factoryId = "60210000-0000-4000-8000-000000000002";
const scorerId = "60210000-0000-4000-8000-000000000003";
const revisionId = "60210000-0000-4000-8000-000000000004";
const scope = { workspaceId, factoryId, scorerId, revisionId };
const revision = {
  id: revisionId,
  scorer_id: scorerId,
  revision_number: 1,
  created_at: "2026-11-19T00:00:00+00:00",
  definition: {
    schemaVersion: 1,
    rubric: "Retain the original historical rubric.",
    requiredEvidence: ["code_diff"],
    scoring: { kind: "boolean", passValue: true },
  },
};

function fixture(fetcher: typeof fetch) {
  return createClient<Database>("http://scorers.test", "reader", {
    auth: { persistSession: false },
    global: { fetch: fetcher },
  });
}

describe("exact scorer revision reads", () => {
  it("loads the historical rubric only when every identity matches", async () => {
    const client = fixture(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe("/rest/v1/factory_scorer_revisions");
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
      expect(url.searchParams.get("scorer_id")).toBe(`eq.${scorerId}`);
      expect(url.searchParams.get("id")).toBe(`eq.${revisionId}`);
      return Response.json([revision]);
    });
    await expect(readFactoryScorerRevision(client, scope)).resolves.toEqual(revision);
  });

  it("returns no revision when scope excludes it", async () => {
    const client = fixture(async () => Response.json([]));
    await expect(readFactoryScorerRevision(client, scope)).resolves.toBeNull();
  });

  it("rejects an invalid stored rubric at the read boundary", async () => {
    const client = fixture(async () => Response.json([{ ...revision, definition: {} }]));
    await expect(readFactoryScorerRevision(client, scope)).rejects.toThrow();
  });
});

it("searches the whole selected factory before pagination and reads only the latest rubric metadata", async () => {
  const cursorName = 'Invoice, "Q4"';
  const client = fixture(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const query = url.searchParams;
    expect(query.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(query.get("factory_id")).toBe(`eq.${factoryId}`);
    if (query.has("id")) {
      expect(query.get("id")).toBe(`eq.${scorerId}`);
      return Response.json([{ id: scorerId, name: cursorName, slug: "invoice-q4" }]);
    }
    expect(query.get("order")).toBe("name.asc,id.asc");
    expect(query.get("factory_scorer_revisions.order")).toBe("revision_number.desc");
    expect(query.get("factory_scorer_revisions.limit")).toBe("1");
    expect(query.get("limit")).toBe("2");
    expect(query.getAll("or")).toEqual([
      String.raw`(name.imatch."Invoice\\*",slug.imatch."Invoice\\*")`,
      String.raw`(name.gt."Invoice, \"Q4\"",and(name.eq."Invoice, \"Q4\"",id.gt.${scorerId}))`,
    ]);
    return Response.json([
      {
        id: revisionId,
        name: "Invoice* A",
        slug: "invoice-a",
        factory_scorer_revisions: [{ definition: revision.definition }],
      },
      { id: factoryId, name: "Invoice* B", slug: "invoice-b", factory_scorer_revisions: [] },
    ]);
  });
  const page = await searchFactoryScorers(client, {
    workspaceId,
    factoryId,
    search: "Invoice*",
    afterId: scorerId,
    limit: 1,
  });
  expect(page).toEqual({
    nextAfterId: revisionId,
    scorers: [
      {
        id: revisionId,
        name: "Invoice* A",
        slug: "invoice-a",
        requirements: { evidence: ["code_diff"], scale: "boolean" },
      },
    ],
  });
});

it("generates a distinct identifier on a collision without retrying a custom identifier", async () => {
  const commands: Array<{ p_slug: string }> = [];
  const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    commands.push(JSON.parse(String(init?.body)));
    return commands.length === 2
      ? Response.json(revision)
      : Response.json({ code: "23505" }, { status: 409 });
  });
  const client = fixture(transport);
  const command = createFactoryScorerSchema.parse({
    name: "Réconciliation Quality",
    definition: revision.definition,
  });
  const actor = { workspaceId, factoryId, actorUserId: scorerId };
  await expect(createFactoryScorer(client, { ...actor, ...command })).resolves.toEqual(revision);
  expect(commands[0]?.p_slug).toBe("reconciliation-quality");
  expect(commands[1]?.p_slug).toMatch(/^reconciliation-quality-[a-f0-9]{12}$/);
  await expect(
    createFactoryScorer(client, { ...actor, ...command, slug: "custom" }),
  ).rejects.toMatchObject({ code: "23505" });
  expect(commands.map(({ p_slug }) => p_slug)).toEqual([
    "reconciliation-quality",
    commands[1]?.p_slug,
    "custom",
  ]);
});
