import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  readFactoryDefinitionCapabilityCheck,
  startFactoryDefinitionCapabilityCheck,
} from "./capability-checks";
import { compileFactoryDefinition } from "./compiler";
import type { FactoryDefinitionCatalog } from "./references";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  complete: vi.fn(),
  latest: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock("@/lib/sandbox-capabilities/server", () => ({
  startSandboxCapabilityCheck: mocks.start,
  completeSandboxCapabilityCheck: mocks.complete,
  getLatestSandboxCapabilityCheck: mocks.latest,
}));
vi.mock("./authority", () => ({ loadFactoryDefinitionCatalog: mocks.catalog }));
const workspaceId = "54200000-0003-4000-8000-000000000001";
const pipelineId = "54200000-0003-4000-8000-000000000002";
const repositoryId = "54200000-0003-4000-8000-000000000003";
const factoryId = "54200000-0003-4000-8000-000000000004";
const actorUserId = "54200000-0003-4000-8000-000000000005";
const writableRepositoryId = "54200000-0003-4000-8000-000000000008";
const readContextRepositoryId = "54200000-0003-4000-8000-000000000009";
const target = { kind: "revision", id: "54200000-0003-4000-8000-000000000006" } as const;
const catalog: FactoryDefinitionCatalog = {
  workspaceId,
  pipelines: [{ id: pipelineId, workspaceId }],
  repositories: [repositoryId, writableRepositoryId, readContextRepositoryId].map((id) => ({
    id,
    workspaceId,
  })),
  executionPolicyRevisions: [],
  deliveryPolicyRevisions: [],
  approvers: [],
  skills: [],
  tools: [],
  sandboxProviders: ["daytona"],
};
const agent = { provider: "claude-code", model: "claude-sonnet-4-6" };
const compiled = compileFactoryDefinition(
  {
    kind: "structured",
    value: {
      schemaVersion: 1,
      kind: "serial",
      pipeline: pipelineId,
      repository: repositoryId,
      writableRepositories: [writableRepositoryId],
      readContextRepositories: [readContextRepositoryId],
      sandboxProvider: "daytona",
      agent: { ...agent, concurrencyLimit: 1, stallTimeoutMs: 60_000, maxRetries: 1, maxTurns: 5 },
      stages: [
        {
          id: "54200000-0003-4000-8000-000000000007",
          slug: "review-design",
          name: "Review design",
          anyoneCanApprove: true,
        },
      ],
    },
  },
  catalog,
);
if (!compiled.ok) throw new Error("The stored candidate fixture must compile.");
const stored = {
  canonical_digest: compiled.canonicalDigest,
  definition_json: compiled.definitionJson,
};

function testClient() {
  return createClient<Database>("http://localhost:9999", "test-service-role", {
    global: {
      fetch: async (input: string | Request | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        if (url.pathname.endsWith("/factories")) return Response.json([{ id: factoryId }]);
        expect(url.pathname).toMatch(/\/factory_definition_revisions$/);
        expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
        expect(url.searchParams.get("id")).toBe(`eq.${target.id}`);
        return Response.json([stored]);
      },
    },
  });
}

describe("saved factory capability checks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.catalog.mockResolvedValue(catalog);
  });

  it("reserves and completes the saved runtime, digest, and exact connection revision", async () => {
    const admin = testClient();
    const check = {
      id: "check-1",
      status: "running",
      sandboxConnectionRevision: "reserved-connection",
    };
    const repository = { id: repositoryId };
    mocks.start.mockResolvedValue({ check, repository });
    const result = await startFactoryDefinitionCapabilityCheck({
      admin,
      workspaceId,
      actorUserId,
      target,
    });
    expect(result).toMatchObject({ ok: true, check });
    if (!result.ok) return;
    const candidate = {
      definitionDigest: compiled.canonicalDigest,
      sandboxProvider: "daytona",
      agent,
    };
    expect(mocks.start).toHaveBeenCalledWith({
      admin,
      workspaceId,
      repositoryId,
      candidate: { ...candidate, actorUserId },
    });
    expect(mocks.complete).not.toHaveBeenCalled();
    await result.complete();
    expect(mocks.complete).toHaveBeenCalledWith({
      admin,
      workspaceId,
      userId: actorUserId,
      checkId: check.id,
      repository,
      candidate: { ...candidate, connectionRevision: "reserved-connection" },
    });
  });

  it("isolates polling from the live receipt and other revisions", async () => {
    const admin = testClient();
    mocks.latest.mockResolvedValue(null);
    await expect(
      readFactoryDefinitionCapabilityCheck({ admin, workspaceId, target }),
    ).resolves.toEqual({ ok: true, check: null });
    expect(mocks.latest).toHaveBeenCalledWith({
      admin,
      workspaceId,
      repositoryId,
      definitionDigest: compiled.canonicalDigest,
    });
  });

  it("reserves and reads an alternate writer's own pinned runtime check", async () => {
    const admin = testClient();
    const scope = { admin, workspaceId, target, repositoryId: writableRepositoryId };
    const check = { status: "running", githubRepositoryId: writableRepositoryId };
    mocks.start.mockResolvedValue({ check, repository: { id: writableRepositoryId } });
    mocks.latest.mockResolvedValue(check);
    await expect(
      startFactoryDefinitionCapabilityCheck({ ...scope, actorUserId }),
    ).resolves.toMatchObject({ ok: true, check });
    await expect(readFactoryDefinitionCapabilityCheck(scope)).resolves.toEqual({ ok: true, check });
    expect(mocks.start).toHaveBeenCalledWith({
      admin,
      workspaceId,
      repositoryId: writableRepositoryId,
      candidate: {
        actorUserId,
        agent,
        definitionDigest: compiled.canonicalDigest,
        sandboxProvider: "daytona",
      },
    });
    expect(mocks.latest).toHaveBeenCalledWith({
      admin,
      workspaceId,
      repositoryId: writableRepositoryId,
      definitionDigest: compiled.canonicalDigest,
    });
  });

  it("rejects both starting and reading a check for read-only context", async () => {
    const scope = {
      admin: testClient(),
      workspaceId,
      target,
      repositoryId: readContextRepositoryId,
    };
    await expect(
      startFactoryDefinitionCapabilityCheck({ ...scope, actorUserId }),
    ).resolves.toMatchObject({ ok: false, status: 422 });
    await expect(readFactoryDefinitionCapabilityCheck(scope)).resolves.toMatchObject({
      ok: false,
      status: 422,
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.latest).not.toHaveBeenCalled();
  });
});
