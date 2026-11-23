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
    created_at: "2026-11-22T23:00:00Z",
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
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return Response.json(rows.slice(offset, offset + limit));
  });
  const supabase = createClient<Database>("https://workflow-fixture.invalid", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  requireWorkspaceAccessById.mockResolvedValue({ ok: true, context: { supabase } });
  return fetch;
}

function get(query: string) {
  return GET(new Request(`http://localhost/workflow?${query}`), {
    params: Promise.resolve(scope),
  });
}

afterEach(() => vi.clearAllMocks());

it("loads the current exact base grant and caps each initial catalog with a next offset", async () => {
  const fetch = mockSignedInPostgrest();
  const response = await get("includeChoices=true");

  expect(response.status).toBe(200);
  const editor = await response.json();
  expect(editor).toMatchObject({
    snapshot: { baseDefinition: { activationId, revisionId, digest } },
    choices: { grant, nextOffsets: { prompts: 100, approvers: 100, profiles: 100 } },
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
  ["prompts", "factory_agent_prompt_revisions", "Builder · Revision 101"],
  ["approvers", "workspace_members", "Approver 101"],
  ["profiles", "factory_definition_revisions", `2026-11-22 · ${digest.slice(0, 10)}`],
])("returns later %s in the original authorization scope", async (catalog, resource, label) => {
  const fetch = mockSignedInPostgrest();
  const response = await get(`catalog=${catalog}&offset=100`);

  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page).toMatchObject({
    catalog,
    items: [{ id: id(300), label }, { id: id(301) }],
    nextOffset: null,
  });
  const url = new URL(String(fetch.mock.calls.at(-1)?.[0]));
  expect(url.pathname).toBe(`/rest/v1/${resource}`);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    workspace_id: `eq.${scope.workspaceId}`,
    offset: "100",
    limit: "101",
    ...(catalog === "approvers"
      ? { kind: "eq.human", is_active: "eq.true" }
      : { factory_id: `eq.${scope.factoryId}` }),
  });
});

it("requires native manager access before fetching later catalog rows", async () => {
  const fetch = mockSignedInPostgrest(false);
  const response = await get("catalog=prompts&offset=100");

  expect(response.status).toBe(404);
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    "/rest/v1/factories",
    "/rest/v1/rpc/read_factory_workflow_authoring",
  ]);
});
