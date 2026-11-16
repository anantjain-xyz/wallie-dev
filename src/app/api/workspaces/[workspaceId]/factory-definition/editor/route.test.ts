import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileFactoryDefinition } from "@/lib/factory-definitions/compiler";
import {
  factoryEditorDocumentResponseSchema,
  factoryEditorPreviewResponseSchema,
  factoryEditorSnapshotResponseSchema,
} from "@/lib/factory-definitions/editor-contracts";
import type { FactoryDefinitionCatalog } from "@/lib/factory-definitions/references";
import type { SerialFactoryDefinitionInput } from "@/lib/factory-definitions/schema";
import type { Database } from "@/lib/supabase/database.types";

const requireWorkspaceAccessById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById }));

import { GET, POST } from "./route";

const workspaceId = "54600000-0000-4000-8000-000000000001";
const factoryId = "54600000-0000-4000-8000-000000000002";
const revisionId = "54600000-0000-4000-8000-000000000003";
const draftId = "54600000-0000-4000-8000-000000000004";
const sourceDraftId = "54600000-0000-4000-8000-000000000005";
const pipelineId = "54600000-0000-4000-8000-000000000006";
const repositoryId = "54600000-0000-4000-8000-000000000007";
const installationId = "54600000-0000-4000-8000-000000000008";
const stageId = "54600000-0000-4000-8000-000000000009";
const stagedPolicyId = "54600000-0000-4000-8000-000000000010";
const createdAt = "2026-11-16T04:10:00.288+00:00";
const routeUrl = `http://localhost/api/workspaces/${workspaceId}/factory-definition/editor`;
const context = () => ({ params: Promise.resolve({ workspaceId }) });

const source = {
  schemaVersion: 1,
  kind: "serial",
  pipeline: "Default",
  repository: "wallie/demo",
  sandboxProvider: "vercel",
  executionPolicy: stagedPolicyId,
  agent: {
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    effort: "high",
    concurrencyLimit: 1,
    stallTimeoutMs: 90_000,
    maxRetries: 1,
    maxTurns: 12,
  },
  stages: [{ id: stageId, slug: "plan", name: "Plan", anyoneCanApprove: true }],
} satisfies SerialFactoryDefinitionInput;

const catalog = {
  workspaceId,
  pipelines: [{ id: pipelineId, workspaceId, aliases: ["Default"] }],
  repositories: [{ id: repositoryId, workspaceId, aliases: ["wallie/demo"] }],
  executionPolicyRevisions: [{ id: stagedPolicyId, workspaceId }],
  deliveryPolicyRevisions: [],
  skills: [],
  tools: [],
  approvers: [],
  sandboxProviders: ["vercel"],
} satisfies FactoryDefinitionCatalog;

function definitionRow(id: string, value: SerialFactoryDefinitionInput) {
  const compiled = compileFactoryDefinition({ kind: "structured", value }, catalog);
  if (!compiled.ok) throw new Error("Invalid fixture definition.");
  return {
    id,
    definition_json: compiled.definitionJson,
    canonical_digest: compiled.canonicalDigest,
    created_at: createdAt,
  };
}

const revision = {
  ...definitionRow(revisionId, { ...source, executionPolicy: null }),
  source_draft_id: sourceDraftId,
};
const draft = {
  ...definitionRow(draftId, source),
  base_activation_number: 4,
  settings_metadata: {
    executionPolicy: {
      id: stagedPolicyId,
      requirements: {
        version: 1,
        maxRepairAttempts: 2,
        maxExecutionMs: 60_000,
        maxTotalTokens: null,
        maxCostUsd: null,
      },
    },
  },
};

function authorized({ initial = false } = {}) {
  const requests: { table: string; query: URLSearchParams; method: string }[] = [];
  const rows: Record<string, { id?: string; [field: string]: unknown }[]> = {
    factories: [{ id: factoryId }],
    factory_definition_activations: initial
      ? []
      : [{ activation_number: 4, revision_id: revisionId }],
    factory_definition_drafts: initial ? [] : [draft],
    factory_definition_revisions: [revision],
    pipelines: [{ id: pipelineId, name: "Default", operating_rules_md: "" }],
    pipeline_stages: [
      {
        id: stageId,
        pipeline_id: pipelineId,
        slug: "plan",
        name: "Plan",
        description: "",
        anyone_can_approve: true,
        approver_member_ids: [],
        prompt_template_md: "",
        position: 1,
        archived_at: null,
      },
    ],
    github_repositories: [
      {
        id: repositoryId,
        full_name: "wallie/demo",
        github_installation_id: installationId,
        workspace_repository_profiles: [{ is_primary: true }],
      },
    ],
    github_installations: [{ id: installationId }],
    execution_policy_revisions: [],
    delivery_policy_revisions: [],
    execution_policies: [],
    delivery_policies: [],
    workspace_onboarding: [],
    workspace_sandbox_settings: [],
    workspace_vercel_sandbox_connections: [{ status: "connected" }],
    workspace_e2b_sandbox_connections: [{ status: "error" }],
    workspace_daytona_sandbox_connections: [
      { status: "connected", api_url: "https://app.daytona.io/api" },
    ],
    workspace_agent_config: [],
    workspace_members: [],
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const { pathname, searchParams: query } = new URL(String(input));
    const table = pathname.split("/").at(-1) ?? "";
    requests.push({ table, query, method: init?.method ?? "GET" });
    if (!(table in rows)) throw new Error(`Unexpected PostgREST request for ${table}`);
    const id = query.get("id");
    return Response.json(id ? rows[table].filter((row) => `eq.${row.id}` === id) : rows[table]);
  });
  const supabase = createClient<Database>("https://editor-fixture.invalid", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, supabase },
  });
  return { requests };
}

function preview(body: unknown) {
  return POST(
    new Request(routeUrl, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    context(),
  );
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("factory definition editor reads", () => {
  it("returns the current revision, shared draft, and only enabled, connected providers", async () => {
    vi.stubEnv("WALLIE_ENABLED_SANDBOX_PROVIDERS", "vercel,e2b");
    const { requests } = authorized();
    const response = await GET(new Request(routeUrl), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const { snapshot } = factoryEditorSnapshotResponseSchema.parse(await response.json());
    expect(snapshot).toMatchObject({
      activationNumber: 4,
      baseline: null,
      readySandboxProviders: ["vercel"],
      published: {
        id: revisionId,
        kind: "revision",
        sourceDraftId,
        digest: revision.canonical_digest,
      },
      draft: { id: draftId, kind: "draft", sourceDraftId: null, digest: draft.canonical_digest },
    });
    expect(snapshot.draft?.source).toMatchObject({
      pipeline: pipelineId,
      repository: repositoryId,
      executionPolicy: stagedPolicyId,
    });
    expect(requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId, { requireManager: true });
    for (const request of requests) {
      expect(request.query.get("workspace_id")).toBe(`eq.${workspaceId}`);
      if (request.table.startsWith("factory_definition_")) {
        expect(request.query.get("factory_id")).toBe(`eq.${factoryId}`);
      }
      expect(request.query.get("select")).not.toMatch(/encrypted_/u);
    }
    expect(
      requests
        .find(({ table }) => table === "factory_definition_drafts")
        ?.query.get("base_activation_number"),
    ).toBe("eq.4");
  });

  it("uses current workspace defaults as an editable seed before the first draft", async () => {
    const { requests } = authorized({ initial: true });
    const response = await GET(new Request(routeUrl), context());
    expect(response.status).toBe(200);
    const { snapshot } = factoryEditorSnapshotResponseSchema.parse(await response.json());
    expect(snapshot).toMatchObject({
      activationNumber: 0,
      published: null,
      draft: null,
      baseline: {
        source: { pipeline: pipelineId, repository: repositoryId, stages: [{ id: stageId }] },
      },
    });
    expect(
      requests
        .find(({ table }) => table === "factory_definition_drafts")
        ?.query.get("base_activation_number"),
    ).toBe("is.null");
  });

  it.each([
    ["revisionId", revisionId, "revision"],
    ["draftId", draftId, "draft"],
  ])("loads an immutable %s by its workspace and factory", async (key, id, kind) => {
    const { requests } = authorized();
    const response = await GET(new Request(`${routeUrl}?${key}=${id}`), context());
    expect(response.status).toBe(200);
    const { document } = factoryEditorDocumentResponseSchema.parse(await response.json());
    expect(document).toMatchObject({ kind, id });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.query.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(requests[1]?.query.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(requests[1]?.query.get("id")).toBe(`eq.${id}`);
  });

  it("rejects conflicting or repeated immutable record selectors", async () => {
    await expect(
      GET(new Request(`${routeUrl}?draftId=${draftId}&revisionId=${revisionId}`), context()),
    ).resolves.toHaveProperty("status", 400);
    await expect(
      GET(new Request(`${routeUrl}?draftId=${draftId}&draftId=${sourceDraftId}`), context()),
    ).resolves.toHaveProperty("status", 400);
    expect(requireWorkspaceAccessById).not.toHaveBeenCalled();
  });

  it("hides unavailable identities and prevents member access before any editor reads", async () => {
    authorized();
    const hidden = await GET(new Request(`${routeUrl}?draftId=${sourceDraftId}`), context());
    expect(hidden.status).toBe(404);
    requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      error: "Manager access required.",
      status: 403,
    });
    expect((await GET(new Request(routeUrl), context())).status).toBe(403);
    expect((await preview({})).status).toBe(403);
  });
});

describe("factory definition editor preview", () => {
  const versions = { expectedActivationNumber: 4, expectedDraftId: draftId };

  it("round-trips structured and JSON edits with the saved draft's staged policy and never writes", async () => {
    const { requests } = authorized();
    const structured = await preview({
      ...versions,
      source: { kind: "structured", value: source },
    });
    expect(structured.status).toBe(200);
    const { content } = factoryEditorPreviewResponseSchema.parse(await structured.json());
    expect(content.digest).toBe(draft.canonical_digest);
    expect(content.source).toMatchObject({ pipeline: pipelineId, executionPolicy: stagedPolicyId });
    const json = await preview({
      ...versions,
      source: { kind: "json", text: JSON.stringify(content.source, null, 2) },
    });
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ content });
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it.each([
    { expectedActivationNumber: 3, expectedDraftId: draftId },
    { expectedActivationNumber: 4, expectedDraftId: null },
  ])("reports a stale activation or shared draft before compiling", async (stale) => {
    const { requests } = authorized();
    const response = await preview({ ...stale, source: { kind: "structured", value: source } });
    expect(response.status).toBe(409);
    expect(requests.map(({ table }) => table)).toEqual([
      "factories",
      "factory_definition_activations",
      "factory_definition_drafts",
    ]);
  });

  it("keeps diagnostics from the same compiler for invalid source", async () => {
    authorized();
    const response = await preview({
      ...versions,
      source: { kind: "json", text: '{"schemaVersion":1,"schemaVersion":1}' },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      diagnostics: [
        { code: "invalid_json", path: [], message: expect.stringContaining("duplicate") },
      ],
    });
  });
});
