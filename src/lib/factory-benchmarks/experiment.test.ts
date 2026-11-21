import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadFactoryDefinitionCatalog } from "@/lib/factory-definitions/authority";
import { compileFactoryDefinition } from "@/lib/factory-definitions/compiler";
import type { FactoryDefinitionCatalog } from "@/lib/factory-definitions/references";
import type { Database } from "@/lib/supabase/database.types";

import {
  freezeBenchmarkExperiment,
  freezeBenchmarkExperimentRequestSchema,
  type BenchmarkExperimentSnapshot,
} from "./experiment";
import { replaySha256 } from "./replay-contracts";

vi.mock("@/lib/factory-definitions/authority", () => ({ loadFactoryDefinitionCatalog: vi.fn() }));

const id = (last: number) => `e6170dab-0000-4000-8000-${String(last).padStart(12, "0")}`;
const scope = { workspaceId: id(1), factoryId: id(2), actorUserId: id(3) };
const command = {
  experimentId: id(4),
  suiteRevisionId: id(5),
  policyRevisionId: id(6),
  definitionRevisionIds: [id(11), id(10).toUpperCase()],
  repetitions: 2,
  seed: 44,
  timeoutMs: 10_000,
};
const snapshot: BenchmarkExperimentSnapshot = {
  experimentId: command.experimentId,
  suiteRevisionId: command.suiteRevisionId,
  policyRevisionId: command.policyRevisionId,
  taskCount: 2,
  candidateCount: 2,
  repetitions: 2,
  expectedTrialCount: 8,
  materializedTrialCount: 8,
  eligibleTrialCount: 4,
  ineligibleTrialCount: 4,
};
const catalog: FactoryDefinitionCatalog = {
  workspaceId: scope.workspaceId,
  factoryId: scope.factoryId,
  pipelines: [{ id: id(20), workspaceId: scope.workspaceId }],
  repositories: [{ id: id(21), workspaceId: scope.workspaceId }],
  executionPolicyRevisions: [],
  deliveryPolicyRevisions: [],
  approvers: [],
  skills: [],
  tools: [],
  sandboxProviders: ["vercel", "e2b"],
};

function definition(
  revisionId: string,
  provider: "codex" | "claude-code",
  model: string,
  sandboxProvider: "vercel" | "e2b" = "vercel",
) {
  const result = compileFactoryDefinition(
    {
      kind: "structured",
      value: {
        schemaVersion: 1,
        kind: "serial",
        pipeline: id(20),
        repository: id(21),
        sandboxProvider,
        agent: {
          provider,
          model,
          concurrencyLimit: 2,
          stallTimeoutMs: 90_000,
          maxRetries: 1,
          maxTurns: 12,
        },
        operatingRulesMd: "",
        stages: [
          {
            id: id(22),
            slug: "work",
            name: "Work",
            anyoneCanApprove: true,
            promptTemplateMd: "Review {{session.prompt}}.",
          },
        ],
      },
    },
    catalog,
  );
  if (!result.ok) throw new Error("The test definition must compile with the fixture catalog.");
  return {
    id: revisionId,
    definition_json: result.definitionJson,
    canonical_digest: result.canonicalDigest,
  };
}

const codex = definition(id(10), "codex", "gpt-5.5");
const claude = definition(id(11), "claude-code", "claude-sonnet-4-6", "e2b");
const databaseOrigin = "https://database.example";
const retryRpc = "find_factory_benchmark_experiment_retry";
const freezeRpc = "freeze_factory_benchmark_experiment";

function database({
  prior = null,
  revisions = [codex, claude],
  result = snapshot,
}: {
  prior?: unknown;
  revisions?: (typeof codex)[];
  result?: unknown;
} = {}) {
  const statements: { name: string; payload: unknown }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(databaseOrigin);
    const name = url.pathname.split("/").at(-1) ?? "";
    const payload: unknown = init?.body
      ? JSON.parse(String(init.body))
      : Object.fromEntries(url.searchParams);
    statements.push({ name, payload });
    if (name === retryRpc || name === freezeRpc) {
      const response = name === retryRpc ? prior : result;
      return response instanceof Response ? response : Response.json(response);
    }
    expect(name).toBe("factory_definition_revisions");
    expect(url.searchParams.get("workspace_id")).toBe(`eq.${scope.workspaceId}`);
    expect(url.searchParams.get("factory_id")).toBe(`eq.${scope.factoryId}`);
    return Response.json(revisions);
  });
  const admin = createClient<Database>(databaseOrigin, "test-server-role-key", {
    global: { fetch: fetcher },
  });
  return {
    admin,
    statements,
    freeze: (request = command) => freezeBenchmarkExperiment({ admin, ...scope, request }),
  };
}

describe("freezeBenchmarkExperiment", () => {
  beforeEach(() => vi.mocked(loadFactoryDefinitionCatalog).mockReset().mockResolvedValue(catalog));

  it("freezes resolved revisions and returns complete counts for eligible and ineligible planned cells", async () => {
    const { freeze, statements } = database();
    await expect(freeze()).resolves.toEqual(snapshot);
    expect(statements.map(({ name }) => name)).toEqual([
      retryRpc,
      "factory_definition_revisions",
      freezeRpc,
    ]);
    const scopeArgs = {
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: scope.actorUserId,
      p_experiment_id: command.experimentId,
      p_suite_revision_id: command.suiteRevisionId,
      p_policy_revision_id: command.policyRevisionId,
      p_repetitions: command.repetitions,
      p_seed: command.seed,
      p_timeout_ms: command.timeoutMs,
    };
    expect(statements[0].payload).toEqual({
      ...scopeArgs,
      p_definition_revision_ids: [codex.id, claude.id],
      p_worker_runtime: "node",
    });
    expect(statements[1].payload).toMatchObject({ id: `in.(${codex.id},${claude.id})` });
    expect(statements[2].payload).toEqual({
      ...scopeArgs,
      p_candidates: [
        {
          definitionRevisionId: codex.id,
          definitionDigest: codex.canonical_digest,
          harness: "codex",
          model: "gpt-5.5",
          sandboxProvider: "vercel",
          workerRuntime: "node",
        },
        {
          definitionRevisionId: claude.id,
          definitionDigest: claude.canonical_digest,
          harness: "claude-code",
          model: "claude-sonnet-4-6",
          sandboxProvider: "e2b",
          workerRuntime: "node",
        },
      ],
    });
  });

  it("reuses the authorized normalized retry after a referenced repository has become unavailable", async () => {
    vi.mocked(loadFactoryDefinitionCatalog).mockResolvedValue({ ...catalog, repositories: [] });
    const { freeze, statements } = database({ prior: snapshot, revisions: [] });
    await expect(
      freeze({ ...command, definitionRevisionIds: [codex.id, claude.id] }),
    ).resolves.toEqual(snapshot);
    expect(statements.map(({ name }) => name)).toEqual([retryRpc]);
    expect(loadFactoryDefinitionCatalog).not.toHaveBeenCalled();
  });

  it("rejects missing revisions within the selected factory before writing anything", async () => {
    const { freeze, statements } = database({ revisions: [codex] });
    await expect(freeze()).rejects.toMatchObject({
      status: 422,
      message: /revision is unavailable/,
    });
    expect(statements.map(({ name }) => name)).toEqual([retryRpc, "factory_definition_revisions"]);
  });

  it("rejects a definition whose bytes do not match its stored revision digest", async () => {
    const { freeze, statements } = database({
      revisions: [codex, { ...claude, definition_json: codex.definition_json }],
    });
    await expect(freeze()).rejects.toMatchObject({ status: 422, message: /integrity check/ });
    expect(statements.some(({ name }) => name === freezeRpc)).toBe(false);
  });

  it("rejects new experiments with a revoked reference without dropping the unresolved candidate", async () => {
    vi.mocked(loadFactoryDefinitionCatalog).mockResolvedValue({ ...catalog, repositories: [] });
    const { freeze, statements } = database();
    await expect(freeze()).rejects.toMatchObject({ status: 422, message: /no longer resolves/ });
    expect(statements.some(({ name }) => name === freezeRpc)).toBe(false);
  });

  it("rejects a new candidate whose configured sandbox provider is unavailable", async () => {
    vi.mocked(loadFactoryDefinitionCatalog).mockResolvedValue({
      ...catalog,
      sandboxProviders: ["vercel"],
    });
    const { freeze, statements } = database();
    await expect(freeze()).rejects.toMatchObject({ status: 422 });
    expect(statements.some(({ name }) => name === freezeRpc)).toBe(false);
  });

  it("rejects an unsupported model and harness pair even when stored bytes have the correct digest", async () => {
    const malformed = codex.definition_json.replace("gpt-5.5", "claude-sonnet-4-6");
    const { freeze, statements } = database({
      revisions: [
        { ...codex, definition_json: malformed, canonical_digest: replaySha256(malformed) },
        claude,
      ],
    });
    await expect(freeze()).rejects.toMatchObject({
      status: 422,
      message: /incompatible model, harness/,
    });
    expect(statements.some(({ name }) => name === freezeRpc)).toBe(false);
  });

  it("uses the database result for conflicts and authorization before accessing candidate configuration", async () => {
    for (const [code, status] of [
      ["PT409", 409],
      ["42501", 403],
    ] as const) {
      const prior = Response.json({ code, message: "https://private.example/binding" }, { status });
      const { freeze, statements } = database({ prior });
      const failure = await freeze().catch((error: unknown) => error);
      expect(failure).toMatchObject({ status });
      expect(String(failure)).not.toContain("https://private.example/binding");
      expect(statements.map(({ name }) => name)).toEqual([retryRpc]);
    }
  });

  it("projects counts and IDs without database-private fields and rejects a partial matrix", async () => {
    const { freeze } = database({
      result: { ...snapshot, privateEndpoint: "https://private.example/binding" },
    });
    await expect(freeze()).resolves.toEqual(snapshot);
    await expect(
      database({ result: { ...snapshot, materializedTrialCount: 7 } }).freeze(),
    ).rejects.toThrow("The frozen benchmark experiment returned an invalid snapshot.");
  });

  it("rejects case-equivalent duplicate revisions and unknown settings before submitting a request", async () => {
    expect(
      freezeBenchmarkExperimentRequestSchema.safeParse({
        ...command,
        definitionRevisionIds: [codex.id, codex.id.toUpperCase()],
      }).success,
    ).toBe(false);
    expect(
      freezeBenchmarkExperimentRequestSchema.safeParse({ ...command, sandboxOverride: "fake" })
        .success,
    ).toBe(false);
    expect(freezeBenchmarkExperimentRequestSchema.safeParse({ ...command, seed: -1 }).success).toBe(
      false,
    );
    expect(
      freezeBenchmarkExperimentRequestSchema.safeParse({
        ...command,
        repetitions: 100,
        definitionRevisionIds: Array.from({ length: 101 }, (_, index) => id(100 + index)),
      }).success,
    ).toBe(false);
  });
});
