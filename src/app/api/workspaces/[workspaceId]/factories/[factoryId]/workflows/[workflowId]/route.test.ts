import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";

import type { WorkflowAuthoringSnapshot } from "@/lib/factory-workflows/authoring-contracts";
import type { Database } from "@/lib/supabase/database.types";

const requireWorkspaceAccessById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById }));

import { GET } from "./route";

function id(value: number) {
  return `65510000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const scope = { workspaceId: id(1), factoryId: id(2), workflowId: id(3) };
const revisionId = id(4);
const activationId = id(5);
const grant = { id: id(6), version: 2 };
const definitionJson = JSON.stringify({
  schemaVersion: 1,
  kind: "serial",
  sandboxProvider: "vercel",
  pipelineId: id(7),
  repositoryId: id(8),
  executionPolicyRevisionId: id(9),
  deliveryPolicyRevisionId: null,
  operatingRulesMd: "",
  skillIds: [],
  toolIds: [],
  operatingRuleStageIds: [],
  executionGrant: grant,
  agent: {
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    effort: "high",
    concurrencyLimit: 1,
    stallTimeoutMs: 90_000,
    maxRetries: 1,
    maxTurns: 12,
  },
  stages: [
    { id: id(10), slug: "plan", name: "Plan", anyoneCanApprove: true, previousStageIds: [] },
  ],
});
const digest = createHash("sha256").update(definitionJson).digest("hex");
const newest = "2026-11-22T23:00:00.000123+00:00";
const oldest = "2026-11-22T23:00:00.000122+00:00";
const snapshot: WorkflowAuthoringSnapshot = {
  workflowId: scope.workflowId,
  displayName: "Release",
  activationId: null,
  draftId: null,
  baseDefinition: { activationId, revisionId, digest },
  draftBaseDefinition: null,
  graph: null,
  draftDigest: null,
  recentDrafts: [],
  publishedDraftId: null,
  publishedGraphRevisionId: null,
  selectedDraftId: null,
  selectedDraftGraph: null,
  selectedDraftDigest: null,
  selectedDraftBaseDefinition: null,
};

function mockSignedInPostgrest(manageable = true) {
  const rows = Array.from({ length: 102 }, (_, index) => ({
    id: id(index + 200),
    revision_number: index + 1,
    factory_agents: { name: "Builder" },
    full_name: `Approver ${index + 1}`,
    canonical_digest: digest,
    created_at: index === 0 ? oldest : newest,
  }));
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const resource = url.pathname.split("/").at(-1);
    if (resource === "factories") return Response.json([{ id: scope.factoryId }]);
    if (resource === "read_factory_workflow_authoring") {
      return Response.json(manageable ? snapshot : null);
    }
    if (url.searchParams.get("select") === "definition_json") {
      return Response.json([{ definition_json: definitionJson }]);
    }
    const dated = url.searchParams.get("order")?.startsWith("created_at.desc");
    const boundary = url.searchParams.get("or");
    const afterId = url.searchParams.get("id")?.replace(/^gt\./, "");
    let matching = rows.toSorted((a, b) =>
      dated
        ? b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
        : a.id.localeCompare(b.id),
    );
    if (boundary) {
      const parts =
        /^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.\1,id\.lt\.([a-f0-9-]+)\)\)$/.exec(
          boundary,
        );
      if (!parts) throw new Error("Invalid dated keyset filter.");
      const [, createdAt, id] = parts;
      matching = matching.filter(
        (row) => row.created_at < createdAt || (row.created_at === createdAt && row.id < id),
      );
    } else if (afterId) {
      matching = matching.filter((row) => row.id > afterId);
    }
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return Response.json(matching.slice(offset, offset + limit));
  });
  const supabase = createClient<Database>("https://workflow-fixture.invalid", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  requireWorkspaceAccessById.mockResolvedValue({ ok: true, context: { supabase } });
  return {
    fetch,
    remove(id: string) {
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) throw new Error("Fixture row could not be removed.");
      rows.splice(index, 1);
    },
  };
}

function get(query: string) {
  return GET(new Request(`http://localhost/workflow?${query}`), {
    params: Promise.resolve(scope),
  });
}

afterEach(() => vi.clearAllMocks());

it("loads the current exact base grant and caps each catalog with a keyset cursor", async () => {
  const { fetch } = mockSignedInPostgrest();
  const response = await get("includeChoices=true");

  expect(response.status).toBe(200);
  const editor = await response.json();
  expect(editor).toMatchObject({
    snapshot: { baseDefinition: { activationId, revisionId, digest } },
    choices: {
      grant,
      nextCursors: {
        prompts: { id: id(202), createdAt: newest },
        approvers: { id: id(299) },
        profiles: { id: id(202), createdAt: newest },
      },
    },
  });
  for (const catalog of ["prompts", "approvers", "profiles"]) {
    expect(editor.choices[catalog]).toHaveLength(100);
  }
  const requests = fetch.mock.calls.map(([url]) => new URL(String(url)));
  const base = requests.find((url) => url.searchParams.get("select") === "definition_json");
  expect(Object.fromEntries(base?.searchParams ?? [])).toMatchObject({
    id: `eq.${revisionId}`,
    canonical_digest: `eq.${digest}`,
    workspace_id: `eq.${scope.workspaceId}`,
    factory_id: `eq.${scope.factoryId}`,
  });
});

it.each([
  ["prompts", "factory_agent_prompt_revisions", [id(201), id(200)], "Builder · Revision 2"],
  ["approvers", "workspace_members", [id(300), id(301)], "Approver 101"],
  [
    "profiles",
    "factory_definition_revisions",
    [id(201), id(200)],
    `2026-11-22 · ${digest.slice(0, 10)}`,
  ],
])(
  "returns surviving later %s after rows are removed from earlier pages",
  async (catalog, resource, later, label) => {
    const { fetch, remove } = mockSignedInPostgrest();
    const editor = await (await get("includeChoices=true")).json();
    const cursor = editor.choices.nextCursors[catalog];
    remove(editor.choices[catalog][0].id);
    remove(cursor.id);
    const query = new URLSearchParams({ catalog, afterId: cursor.id });
    if (cursor.createdAt) query.set("afterCreatedAt", cursor.createdAt);
    const response = await get(query.toString());

    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).toMatchObject({
      catalog,
      items: [{ id: later[0], label }, { id: later[1] }],
      nextCursor: null,
    });
    const url = new URL(String(fetch.mock.calls.at(-1)?.[0]));
    expect(url.pathname).toBe(`/rest/v1/${resource}`);
    expect(url.searchParams.has("offset")).toBe(false);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      workspace_id: `eq.${scope.workspaceId}`,
      limit: "101",
      ...(catalog === "approvers"
        ? { kind: "eq.human", is_active: "eq.true", id: `gt.${cursor.id}` }
        : {
            factory_id: `eq.${scope.factoryId}`,
            or: `(created_at.lt.${newest},and(created_at.eq.${newest},id.lt.${cursor.id}))`,
          }),
    });
  },
);

it("requires native manager access before fetching later catalog rows", async () => {
  const { fetch } = mockSignedInPostgrest(false);
  const response = await get(`catalog=approvers&afterId=${id(299)}`);

  expect(response.status).toBe(404);
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    "/rest/v1/factories",
    "/rest/v1/rpc/read_factory_workflow_authoring",
  ]);
});
