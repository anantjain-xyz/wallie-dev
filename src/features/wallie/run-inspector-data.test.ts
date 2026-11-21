import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RunCatalogWorkspaceUnavailableError } from "@/features/wallie/run-catalog";
import {
  loadRunInspectorArtifact,
  loadRunInspectorCredential,
  loadRunInspectorContext,
  loadRunInspectorData,
  loadRunInspectorExecutionProfile,
  loadRunInspectorMcpManifest,
  loadRunInspectorRoutingDecision,
  loadRunInspectorSkills,
} from "@/features/wallie/run-inspector-data";
import { RunTranscriptResetError } from "@/features/wallie/run-transcript";
import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  catalog: vi.fn(),
  factories: vi.fn(),
  transcript: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/features/workspaces/workspace-layout-data", () => ({
  loadWorkspaceLayoutContext: mocks.context,
}));
vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocks.factories,
}));
vi.mock("@/features/wallie/run-catalog", () => ({
  loadWorkspaceRunCatalogItem: mocks.catalog,
  RunCatalogWorkspaceUnavailableError: class extends Error {},
}));
vi.mock("@/features/wallie/run-transcript", () => ({
  loadRunTranscript: mocks.transcript,
  RunTranscriptResetError: class extends Error {},
}));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const run = {
  id: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  attemptCount: 4,
  sessionNumber: 42,
};
const artifactId = "00000000-0000-4000-8000-000000000004";
const artifactRow = {
  id: artifactId,
  stage_slug: "build",
  version: 2,
  created_at: "2026-11-14T20:00:00Z",
};
const skillRevision = {
  skillId: "00000000-0000-4000-8000-000000000006",
  revisionId: "00000000-0000-4000-8000-000000000007",
  name: "Check release evidence",
  version: 2,
  contentSha256: "a".repeat(64),
  sourceKind: "repository",
};
const receipt = {
  binding_id: "00000000-0000-4000-8000-000000000008",
  binding_version: 1,
  material_revision: 3,
  service_principal_id: "00000000-0000-4000-8000-000000000009",
  resolved_at: "2026-11-14T20:00:00Z",
  encrypted_value: "synthetic-ciphertext-never-display",
};

function fixture({
  checkpoint = true,
  artifact = true,
  revisions = null,
  credential = false,
  mcp = null,
  executionProfile = null,
  routingDecision = null,
  failure,
}: {
  checkpoint?: boolean;
  artifact?: boolean;
  revisions?: unknown;
  credential?: boolean;
  mcp?: unknown;
  executionProfile?: unknown;
  routingDecision?: unknown;
  failure?: string;
} = {}) {
  const requests: URL[] = [];
  const skillRequests: unknown[] = [];
  const mcpRequests: unknown[] = [];
  const profileRequests: unknown[] = [];
  const routingRequests: unknown[] = [];
  const supabase = createClient<Database>("https://database.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        requests.push(url);
        const table = url.pathname.split("/").at(-1);
        if (table === "get_run_skill_revisions") {
          skillRequests.push(JSON.parse(String(init?.body)));
          return table === failure
            ? Response.json({ message: "private database error" }, { status: 403 })
            : Response.json(revisions);
        }
        if (table === "get_run_mcp_manifest") {
          mcpRequests.push(JSON.parse(String(init?.body)));
          return Response.json(mcp);
        }
        if (table === "get_run_execution_profile") {
          profileRequests.push(JSON.parse(String(init?.body)));
          return table === failure
            ? Response.json({ message: "private database error" }, { status: 403 })
            : Response.json(executionProfile);
        }
        if (table === "get_run_routing_decision") {
          routingRequests.push(JSON.parse(String(init?.body)));
          return table === failure
            ? Response.json({ message: "private database error" }, { status: 403 })
            : Response.json(routingDecision);
        }
        const data =
          table === "factory_run_credential_receipts"
            ? credential
              ? [receipt]
              : []
            : table === "session_git_checkpoints"
              ? checkpoint
                ? [{ artifact_id: artifactId }]
                : []
              : artifact
                ? [artifactRow]
                : [];
        return new Response(
          JSON.stringify(table === failure ? { message: "private database error" } : data),
          {
            status: table === failure ? 403 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  });
  return {
    requests,
    skillRequests,
    mcpRequests,
    profileRequests,
    routingRequests,
    input: { supabase, workspaceId, workspaceSlug: "wallie", run },
  };
}

beforeEach(() => vi.clearAllMocks());

const historicalRoutingReceipt = {
  factoryId: workspaceId,
  canManageFactory: false,
  taskClassName: "Original verification",
  benchmarkEvidence: null,
  decision: {
    version: 1,
    mode: "shadow",
    policyRevisionId: artifactId,
    policyDigest: "a".repeat(64),
    taskClassSlug: "verify",
    taskClassId: run.sessionId,
    ruleId: skillRevision.skillId,
    initialReason: "qualification_unavailable",
    disposition: "escalated",
    source: null,
    reason: "authority_unavailable",
    configuration: null,
    benchmarkCandidateKey: null,
  },
};

it("loads the original routing receipt for this workspace, run, and attempt", async () => {
  const { input, routingRequests } = fixture({ routingDecision: historicalRoutingReceipt });
  await expect(loadRunInspectorRoutingDecision(input)).resolves.toEqual({
    kind: "recorded",
    receipt: historicalRoutingReceipt,
  });
  expect(routingRequests).toEqual([
    { target_workspace_id: workspaceId, target_run_id: run.id, target_attempt_count: 4 },
  ]);
});

it("distinguishes missing routing decisions from unreadable or invalid receipts", async () => {
  const missing = fixture();
  await expect(loadRunInspectorRoutingDecision(missing.input)).resolves.toEqual({
    kind: "unrecorded",
  });
  const queued = fixture();
  await expect(
    loadRunInspectorRoutingDecision({ ...queued.input, run: { ...run, attemptCount: null } }),
  ).resolves.toEqual({ kind: "unrecorded" });
  expect(queued.routingRequests).toHaveLength(0);

  const failed = fixture({ failure: "get_run_routing_decision" });
  await expect(loadRunInspectorRoutingDecision(failed.input)).resolves.toEqual({
    kind: "unavailable",
  });
  const malformed = fixture({
    routingDecision: { ...historicalRoutingReceipt, privateInput: "secret" },
  });
  await expect(loadRunInspectorRoutingDecision(malformed.input)).resolves.toEqual({
    kind: "unavailable",
  });
});

it("loads the recorded profile only for the exact attempt and rejects unexpected private fields", async () => {
  const profile = {
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    effort: "high",
    maxTurns: 5,
    sandboxProvider: "e2b",
    sandboxConnectionRevision: artifactId,
    workerRuntime: "workerd",
    definitionRevisionId: artifactId,
    factoryId: workspaceId,
    agentId: run.id,
    promptRevisionId: artifactId,
    invokingMemberId: run.sessionId,
    triggeredByMemberId: null,
    authority: { kind: "human", memberId: run.sessionId },
  };
  const valid = fixture({ executionProfile: profile });
  expect(await loadRunInspectorExecutionProfile(valid.input)).toEqual({
    kind: "recorded",
    profile,
  });
  expect(valid.profileRequests).toEqual([
    {
      target_workspace_id: workspaceId,
      target_run_id: run.id,
      target_attempt_count: run.attemptCount,
    },
  ]);
  const unavailable = fixture({ executionProfile: { ...profile, token: "private value" } });
  expect(await loadRunInspectorExecutionProfile(unavailable.input)).toEqual({
    kind: "unavailable",
  });
  const unrecorded = fixture();
  expect(await loadRunInspectorExecutionProfile(unrecorded.input)).toEqual({ kind: "unrecorded" });
  const queued = fixture();
  expect(
    await loadRunInspectorExecutionProfile({
      ...queued.input,
      run: { ...run, attemptCount: null },
    }),
  ).toEqual({ kind: "unrecorded" });
  expect(queued.profileRequests).toEqual([]);
});

it("exposes only the exact planned MCP manifest and rejects material-bearing payloads", async () => {
  const payload = {
    kind: "planned",
    manifest: {
      agentId: run.sessionId,
      servers: [
        {
          serverId: run.id,
          serverSlug: "docs",
          toolRevisionId: artifactId,
          revisionNumber: 2,
          endpoint: "https://tools.example.test/mcp",
          operations: ["read_page"],
          auth: { kind: "bearer", secretBindingId: receipt.binding_id },
        },
      ],
    },
  };
  const allowed = fixture({ mcp: payload });
  expect(
    await loadRunInspectorMcpManifest({
      ...allowed.input,
      run: { ...run, attemptCount: null },
    }),
  ).toEqual(payload);
  expect(allowed.requests[0]?.pathname).toBe("/rest/v1/rpc/get_run_mcp_manifest");
  expect(allowed.mcpRequests[0]).toEqual({
    target_workspace_id: workspaceId,
    target_run_id: run.id,
  });
  const malformed = fixture({ mcp: { ...payload, credentialValue: "synthetic-unsafe-material" } });
  expect(await loadRunInspectorMcpManifest(malformed.input)).toBeNull();
  expect(malformed.mcpRequests[0]).toMatchObject({ target_attempt_count: run.attemptCount });
});

describe("exact-attempt credential provenance", () => {
  it("reads only safe metadata for the exact session, run and attempt", async () => {
    const { input, requests } = fixture({ credential: true });
    expect(await loadRunInspectorCredential(input)).toEqual({
      bindingId: receipt.binding_id,
      bindingVersion: 1,
      materialRevision: 3,
      servicePrincipalId: receipt.service_principal_id,
      resolvedAt: receipt.resolved_at,
    });
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({
      select: "binding_id,binding_version,material_revision,service_principal_id,resolved_at",
      workspace_id: `eq.${workspaceId}`,
      session_id: `eq.${run.sessionId}`,
      run_id: `eq.${run.id}`,
      attempt_count: "eq.4",
    });
  });
});

describe("exact-attempt skill revisions", () => {
  it("reads safe revision metadata for the exact run and attempt through the caller's client", async () => {
    const { input, requests, skillRequests } = fixture({ revisions: [skillRevision] });
    expect(await loadRunInspectorSkills(input)).toEqual({
      kind: "recorded",
      revisions: [skillRevision],
    });
    expect(requests.map((request) => request.pathname)).toEqual([
      "/rest/v1/rpc/get_run_skill_revisions",
    ]);
    expect(skillRequests).toEqual([
      {
        target_workspace_id: workspaceId,
        target_run_id: run.id,
        target_attempt_count: run.attemptCount,
      },
    ]);
  });

  it("distinguishes no recorded manifest from a manifest with no selected revisions", async () => {
    const withoutManifest = fixture();
    expect(await loadRunInspectorSkills(withoutManifest.input)).toEqual({ kind: "unrecorded" });
    const withoutSkills = fixture({ revisions: [] });
    expect(await loadRunInspectorSkills(withoutSkills.input)).toEqual({
      kind: "recorded",
      revisions: [],
    });
  });

  it("skips a run without an attempt and withholds malformed or failed reads", async () => {
    const unclaimed = fixture();
    expect(
      await loadRunInspectorSkills({
        ...unclaimed.input,
        run: { ...run, attemptCount: null },
      }),
    ).toEqual({ kind: "unrecorded" });
    expect(unclaimed.requests).toEqual([]);

    const malformed = fixture({ revisions: [{ ...skillRevision, contentMd: "private body" }] });
    expect(await loadRunInspectorSkills(malformed.input)).toEqual({ kind: "unavailable" });
    const failed = fixture({ failure: "get_run_skill_revisions" });
    expect(await loadRunInspectorSkills(failed.input)).toEqual({ kind: "unavailable" });
  });
});

describe("exact-attempt accepted artifact", () => {
  it("reads only metadata through the caller's client and links the accepted stage/version", async () => {
    const { requests, input } = fixture();
    expect(await loadRunInspectorArtifact(input)).toEqual({
      kind: "available",
      id: artifactId,
      stageSlug: "build",
      version: 2,
      createdAt: artifactRow.created_at,
      href: `/w/wallie/sessions/42?artifactStage=build&artifactVersion=2&artifactId=${artifactId}`,
    });
    expect(requests).toHaveLength(2);
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({
      select: "artifact_id",
      workspace_id: `eq.${workspaceId}`,
      session_id: `eq.${run.sessionId}`,
      run_id: `eq.${run.id}`,
      attempt_count: "eq.4",
    });
    expect(Object.fromEntries(requests[1].searchParams)).toEqual({
      select: "id,stage_slug,version,created_at",
      workspace_id: `eq.${workspaceId}`,
      session_id: `eq.${run.sessionId}`,
      id: `eq.${artifactId}`,
    });
  });

  it("does not guess an artifact from the latest session output when no exact checkpoint exists", async () => {
    const { requests, input } = fixture({ checkpoint: false });
    expect(await loadRunInspectorArtifact(input)).toEqual({ kind: "none" });
    expect(requests).toHaveLength(1);
  });

  it("does not look up an unrecorded attempt", async () => {
    const { requests, input } = fixture();
    expect(
      await loadRunInspectorArtifact({ ...input, run: { ...run, attemptCount: null } }),
    ).toEqual({ kind: "unrecorded" });
    expect(requests).toHaveLength(0);
  });

  it.each(["session_git_checkpoints", "session_artifacts"])(
    "keeps a failed %s lookup distinct from no artifact",
    async (failure) => {
      const { input } = fixture({ failure });
      expect(await loadRunInspectorArtifact(input)).toEqual({ kind: "unavailable" });
    },
  );

  it("does not reveal an inaccessible artifact", async () => {
    const { input } = fixture({ artifact: false });
    expect(await loadRunInspectorArtifact(input)).toEqual({ kind: "unavailable" });
  });
});

describe("run inspector composition", () => {
  function prepare(
    role: "member" | "owner" | "admin" = "member",
    factoryStatus: "active" | "archived" = "active",
  ) {
    const { input, routingRequests } = fixture({
      revisions: [skillRevision],
      routingDecision: historicalRoutingReceipt,
    });
    mocks.context.mockResolvedValue({
      currentMember: { id: run.sessionId, kind: "human", is_active: true, role },
      supabase: input.supabase,
      workspace: { id: workspaceId, slug: "wallie" },
    });
    mocks.factories.mockResolvedValue([{ id: workspaceId, status: factoryStatus }]);
    mocks.catalog.mockResolvedValue({ ...run, status: "canceled", interrupted: false });
    mocks.transcript.mockResolvedValue({
      runId: run.id,
      attemptCount: run.attemptCount,
      runStatus: "canceled",
      entries: [],
    });
    return { input, routingRequests };
  }

  it.each([
    ["owner", "active", true],
    ["admin", "active", true],
    ["member", "active", false],
    ["owner", "archived", false],
  ] as const)(
    "matches Settings page access for a workspace %s and %s factory",
    async (role, factoryStatus, canOpen) => {
      prepare(role, factoryStatus);
      const data = await loadRunInspectorData("wallie", run.id);
      expect(data.canOpenRoutingPolicy).toBe(canOpen);
    },
  );

  it("uses the newest exact transcript status so a cancellation between reads is not revived", async () => {
    const { input } = prepare();
    mocks.catalog.mockResolvedValueOnce({ ...run, status: "running", interrupted: false });
    const data = await loadRunInspectorData("wallie", run.id);
    expect(data.run).toMatchObject({ id: run.id, status: "canceled", interrupted: false });
    expect(mocks.catalog).toHaveBeenCalledWith({
      supabase: input.supabase,
      workspaceId,
      workspaceSlug: "wallie",
      runId: run.id,
    });
    expect(mocks.transcript).toHaveBeenCalledWith({
      supabase: input.supabase,
      workspaceId,
      runId: run.id,
    });
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
  });

  it("reloads a queued run's claimed attempt before reading evidence", async () => {
    const { routingRequests } = prepare();
    mocks.catalog.mockResolvedValueOnce({
      ...run,
      attemptCount: null,
      status: "canceled",
      interrupted: false,
    });
    const data = await loadRunInspectorData("wallie", run.id);
    expect(data.run.attemptCount).toBe(4);
    expect(data.artifact.kind).toBe("available");
    expect(data.skills).toEqual({ kind: "recorded", revisions: [skillRevision] });
    expect(data.routingDecision).toEqual({ kind: "recorded", receipt: historicalRoutingReceipt });
    expect(routingRequests).toEqual([
      { target_workspace_id: workspaceId, target_run_id: run.id, target_attempt_count: 4 },
    ]);
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid run id before data reads", async () => {
    prepare();
    await expect(loadRunInspectorData("wallie", "invalid")).rejects.toThrow("NOT_FOUND");
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.transcript).not.toHaveBeenCalled();
  });

  it("returns not-found for absent or inaccessible runs", async () => {
    prepare();
    mocks.catalog.mockResolvedValue(null);
    await expect(loadRunInspectorData("wallie", run.id)).rejects.toThrow("NOT_FOUND");
    expect(mocks.transcript).not.toHaveBeenCalled();
  });

  it("returns not-found when membership is revoked between reads", async () => {
    prepare();
    mocks.transcript.mockResolvedValue(null);
    await expect(loadRunInspectorData("wallie", run.id)).rejects.toThrow("NOT_FOUND");
  });

  it("restarts an initial transcript once when capture begins during the read", async () => {
    prepare();
    mocks.transcript.mockRejectedValueOnce(new RunTranscriptResetError());
    const data = await loadRunInspectorData("wallie", run.id);
    expect(data.run.id).toBe(run.id);
    expect(mocks.transcript).toHaveBeenCalledTimes(2);
  });

  it("bounds source-transition retries and keeps revocation as not-found", async () => {
    prepare();
    mocks.transcript
      .mockRejectedValueOnce(new RunTranscriptResetError())
      .mockRejectedValueOnce(new RunTranscriptResetError());
    await expect(loadRunInspectorData("wallie", run.id)).rejects.toBeInstanceOf(
      RunTranscriptResetError,
    );
    expect(mocks.transcript).toHaveBeenCalledTimes(2);
    mocks.transcript
      .mockClear()
      .mockRejectedValueOnce(new RunTranscriptResetError())
      .mockResolvedValueOnce(null);
    await expect(loadRunInspectorData("wallie", run.id)).rejects.toThrow("NOT_FOUND");
  });

  it("maps unavailable workspaces to not-found while preserving ordinary read failures", async () => {
    prepare();
    mocks.catalog.mockRejectedValueOnce(new RunCatalogWorkspaceUnavailableError());
    await expect(loadRunInspectorData("wallie", run.id)).rejects.toThrow("NOT_FOUND");
    mocks.catalog.mockRejectedValueOnce(new Error("Read failed"));
    await expect(loadRunInspectorData("wallie", run.id)).rejects.toThrow("Read failed");
  });
});

describe("exact frozen input inspection", () => {
  const document = {
    sourceId: "00000000-0000-4000-8000-000000000010",
    revisionId: "00000000-0000-4000-8000-000000000011",
    status: "selected",
    reason: "exact_revision",
    upstreamRevision: "a".repeat(40),
    contentSha256: "b".repeat(64),
    contentBytes: 4,
    stale: true,
    sha256: "c".repeat(64),
    utf8Bytes: 4,
  };
  const projection = (documents: unknown[]) => ({
    factoryId: "00000000-0000-4000-8000-000000000012",
    canManage: false,
    originRunId: null,
    manifestSha256: "d".repeat(64),
    createdAt: "2026-11-14T20:00:00Z",
    manifest: {
      version: 1,
      required: [],
      documents,
      conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
      budget: {
        maxUtf8Bytes: 131072,
        maxEstimatedTokens: 32768,
        usedUtf8Bytes: 4,
        estimatedTokens: 4,
      },
    },
  });

  it("reads the exact attempt while preserving safe receipt IDs for ordinary reviewers", async () => {
    const calls: unknown[] = [];
    const supabase = createClient<Database>("https://database.example.test", "test-key", {
      global: {
        fetch: async (_input, request) => {
          calls.push(JSON.parse(String(request?.body)));
          return Response.json(projection([document]));
        },
      },
    });
    await expect(loadRunInspectorContext({ supabase, workspaceId, run })).resolves.toMatchObject({
      kind: "recorded",
      context: { canManage: false, manifest: { documents: [document] } },
    });
    expect(calls).toEqual([
      { target_workspace_id: workspaceId, target_run_id: run.id, target_attempt_count: 4 },
    ]);
  });

  it.each([
    { ...document, filePath: "docs/private.md" },
    { ...document, content: "private body" },
  ])(
    "fails closed if a reviewer projection includes private fields",
    async (unexpectedDocument) => {
      const supabase = createClient<Database>("https://database.example.test", "test-key", {
        global: { fetch: async () => Response.json(projection([unexpectedDocument])) },
      });
      await expect(loadRunInspectorContext({ supabase, workspaceId, run })).resolves.toEqual({
        kind: "unavailable",
      });
    },
  );
});
