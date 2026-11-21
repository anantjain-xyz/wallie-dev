import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { runtimeMcpManifest } from "@/lib/factory-mcp/manifest";
import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import { renderStagePrompt } from "@/lib/prompt-templates";
import type { Database } from "@/lib/supabase/database.types";

import { compareFactoryDefinitions } from "./semantic-diff";
import {
  compileFactoryDefinition,
  factoryComponentRevisionsForBundle,
  factoryComponentRevisionsForSource,
} from "./compiler";
import type { FactoryDefinitionCatalog } from "./references";
import { compiledFactoryDefinitionSchema, type SerialFactoryDefinitionInput } from "./schema";
import { factoryWritableRepositoryIds } from "./repository-bindings";
import { loadQualifiedModelRoutingConfigurations } from "./routing-catalog";
import { factoryDefinitionFromBundle, recompileStoredFactoryDefinition } from "./stored-definition";

const workspaceId = "c5410000-0000-4000-8000-000000000001";
const otherWorkspaceId = "c5410000-0000-4000-8000-000000000002";
const pipelineId = "c5410000-0000-4000-8000-000000000003";
const repositoryId = "c5410000-0000-4000-8000-000000000004";
const otherRepositoryId = "c5410000-0000-4000-8000-000000000005";
const executionPolicyId = "c5410000-0000-4000-8000-000000000006";
const deliveryPolicyId = "c5410000-0000-4000-8000-000000000007";
const firstStageId = "c5410000-0000-4000-8000-000000000008";
const lastStageId = "c5410000-0000-4000-8000-000000000009";
const approverId = "c5410000-0000-4000-8000-000000000010";
const otherApproverId = "c5410000-0000-4000-8000-000000000011";
const agentId = "c5410000-0000-4000-8000-000000000012";
const promptRevisionId = "c5410000-0000-4000-8000-000000000013";
const docsRepositoryId = "c5410000-0000-4000-8000-000000000014";
const grantId = "c5410000-0000-4000-8000-000000000020";
const servicePrincipalId = "c5410000-0000-4000-8000-000000000021";
const docsMcpRevisionId = "ca410000-0000-4000-8000-000000000022";
const buildMcpRevisionId = "c5410000-0000-4000-8000-000000000023";
const docsMcpServerId = "c5410000-0000-4000-8000-000000000024";
const buildMcpServerId = "c5410000-0000-4000-8000-000000000025";
const mcpBindingId = "ba410000-0000-4000-8000-000000000026";
const factoryId = "c5410000-0000-4000-8000-000000000027";
const otherFactoryId = "c5410000-0000-4000-8000-000000000028";
const scorerRevisionId = "c5410000-0000-4000-8000-000000000029";
const laterScorerRevisionId = "c5410000-0000-4000-8000-000000000030";
const sourceRevisionId = "c5410000-0000-4000-8000-000000000031";
const experimentId = "c5410000-0000-4000-8000-000000000032";
const qualificationId = "c5410000-0000-4000-8000-000000000033";
const fallbackQualificationId = "c5410000-0000-4000-8000-000000000034";
const taskClassId = "c5410000-0000-4000-8000-000000000035";
const ruleId = "c5410000-0000-4000-8000-000000000036";

const catalog: FactoryDefinitionCatalog = {
  workspaceId,
  pipelines: [{ id: pipelineId, workspaceId, aliases: ["Delivery pipeline"] }],
  repositories: [{ id: repositoryId, workspaceId, aliases: ["wallie/demo"] }],
  executionPolicyRevisions: [{ id: executionPolicyId, workspaceId, aliases: ["Spend guard"] }],
  deliveryPolicyRevisions: [
    { id: deliveryPolicyId, workspaceId, pipelineId, aliases: ["PR policy"] },
  ],
  skills: [
    { id: "review@1", workspaceId, aliases: ["Review"] },
    { id: "proof@2", workspaceId, aliases: ["Proof"], sandboxProviders: ["vercel"] },
  ],
  tools: [],
  approvers: [
    { id: approverId, workspaceId },
    { id: otherApproverId, workspaceId },
  ],
  sandboxProviders: ["vercel"],
};

function candidate(): SerialFactoryDefinitionInput {
  return {
    schemaVersion: 1,
    kind: "serial",
    pipeline: "Delivery pipeline",
    repository: "wallie/demo",
    sandboxProvider: "vercel",
    agent: {
      provider: "claude_code",
      model: "claude-sonnet-4-6",
      effort: "high",
      concurrencyLimit: 2,
      stallTimeoutMs: 90_000,
      maxRetries: 1,
      maxTurns: 12,
    },
    operatingRulesMd: "{{#if artifact.previousStages.discover-risk}}Check the evidence.{{/if}}",
    executionPolicy: "Spend guard",
    deliveryPolicy: "PR policy",
    skills: ["Review", "Proof"],
    tools: [],
    stages: [
      {
        id: firstStageId,
        slug: "discover-risk",
        name: "Découvrir les risques",
        anyoneCanApprove: true,
        promptTemplateMd: "Inspect {{session.prompt}}.",
      },
      {
        id: lastStageId,
        slug: "prepare-release",
        name: "Prepare the release",
        approverMemberIds: [otherApproverId, approverId],
        promptTemplateMd: "Use {{artifact.previousStages.discover-risk}} to prepare the release.",
      },
    ],
  };
}

function compile(value: unknown, references: FactoryDefinitionCatalog = catalog) {
  return compileFactoryDefinition({ kind: "structured", value }, references);
}

function mcpFixture() {
  const input = {
    ...candidate(),
    implementationAgent: promptRevisionId,
    executionGrant: { id: grantId, version: 3 },
    mcpBindings: [
      { toolRevisionId: buildMcpRevisionId, operations: ["list"] },
      {
        toolRevisionId: docsMcpRevisionId.toUpperCase(),
        operations: ["search", "Read"],
        secretBindingId: mcpBindingId.toUpperCase(),
      },
    ],
  };
  const references: FactoryDefinitionCatalog = {
    ...catalog,
    agentPromptRevisions: [
      {
        id: promptRevisionId,
        workspaceId,
        agentId,
        promptRevisionId,
        promptMd: "",
        promptSha256: createHash("sha256").update("").digest("hex"),
      },
    ],
    tools: [
      {
        id: docsMcpRevisionId,
        workspaceId,
        serverId: docsMcpServerId,
        serverSlug: "reference-docs",
        endpoint: "https://docs.example.test/mcp",
        revisionNumber: 2,
        authKind: "bearer",
        operations: ["Read", "archive", "search"],
      },
      {
        id: buildMcpRevisionId,
        workspaceId,
        serverId: buildMcpServerId,
        serverSlug: "build-catalog",
        endpoint: "https://builds.example.test/mcp",
        revisionNumber: 1,
        authKind: "none",
        operations: ["list"],
      },
    ],
    mcpSecretBindings: [
      {
        id: mcpBindingId,
        workspaceId,
        grantId,
        agentId,
        servicePrincipalId,
        toolRevisionId: docsMcpRevisionId,
      },
    ],
    mcpExecutionGrant: {
      id: grantId,
      workspaceId,
      servicePrincipalId,
      version: 3,
      toolIds: [
        `${docsMcpRevisionId}/Read`,
        `${docsMcpRevisionId}/search`,
        `${buildMcpRevisionId}/list`,
      ],
    },
  };
  return { input, references };
}

describe("factory model routing", () => {
  const configuration = {
    agentId,
    definitionRevisionId: sourceRevisionId,
    experimentId,
    qualificationId,
    harness: "codex",
    modelKey: "openai/gpt-5.4-2026-03-05",
    workerRuntime: "node",
  } as const;
  const fallback = {
    ...configuration,
    qualificationId: fallbackQualificationId,
    modelKey: "openai/gpt-5.4-mini-2026-03-17",
  };
  const policy = {
    version: 1,
    taskClasses: [{ id: taskClassId, slug: "bug-fix", name: "Bug fix" }],
    rules: [
      {
        id: ruleId,
        taskClassId,
        configuration,
        constraints: {
          qualityFloorBps: 8_000,
          maxMeanCostUsd: null,
          maxLatencyMs: 60_000,
          minResolvedTrials: 10,
          minConfidenceBps: 9_000,
        },
        onUnavailable: { kind: "fallback", configuration: fallback },
      },
    ],
    onUnmatched: { kind: "escalate" },
  };
  const scope = { workspaceId, factoryId };
  const qualified = [configuration, fallback].map((target) => ({ ...target, ...scope }));
  const references = { ...catalog, factoryId, modelRoutingConfigurations: qualified };

  it("round-trips routing through the factory digest and retains bytes after another edit", () => {
    const value = { ...candidate(), modelRouting: policy };
    const original = compile(value, references);
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    expect(original.bundle.modelRouting).toEqual(policy);
    for (const selection of [
      factoryComponentRevisionsForSource({ kind: "structured", value }),
      factoryComponentRevisionsForBundle(original.bundle),
    ]) {
      expect(selection).toHaveProperty("modelRoutingConfigurations", [configuration, fallback]);
    }
    expect(
      recompileStoredFactoryDefinition(
        original.definitionJson,
        original.canonicalDigest,
        references,
      ),
    ).toEqual(original);
    const edited = compile(
      {
        ...factoryDefinitionFromBundle(original.bundle),
        modelRouting: { ...policy, taskClasses: [{ ...policy.taskClasses[0], name: "Fix" }] },
      },
      references,
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.canonicalDigest).not.toBe(original.canonicalDigest);
    expect(JSON.parse(original.definitionJson).modelRouting).toEqual(policy);
    expect(edited.bundle.agent).toEqual(original.bundle.agent);
    expect(compareFactoryDefinitions(original.bundle, edited.bundle)).toMatchObject({
      fields: [{ label: "Model routing policy", multiline: true }],
      stages: [],
    });
  });

  it("rejects missing, cross-factory, mismatched, and ambiguous qualification records", () => {
    const value = { ...candidate(), modelRouting: policy };
    const badConfigurations = [
      [],
      [qualified[0], { ...qualified[1], factoryId: otherFactoryId }],
      [qualified[0], { ...qualified[1], workerRuntime: "workerd" as const }],
    ];
    for (const modelRoutingConfigurations of badConfigurations) {
      expect(compile(value, { ...references, modelRoutingConfigurations })).toMatchObject({
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            path: ["modelRouting", "rules", 0, "onUnavailable", "configuration"],
            code: "missing_reference",
          }),
        ]),
      });
    }
    expect(
      compile(value, { ...references, modelRoutingConfigurations: [...qualified, qualified[0]] }),
    ).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "ambiguous_reference" })],
    });
  });

  it("batch-resolves exact frozen candidate receipts against their definition bytes and agent", async () => {
    const fixture = mcpFixture();
    const source = compile(fixture.input, fixture.references);
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const queries: URL[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      queries.push(url);
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
      if (url.pathname.endsWith("/factory_definition_revisions")) {
        expect(url.searchParams.get("id")).toBe(`in.(${sourceRevisionId})`);
        return Response.json([
          {
            id: sourceRevisionId,
            canonical_digest: source.canonicalDigest,
            definition_json: source.definitionJson,
          },
        ]);
      }
      expect(url.pathname.endsWith("/factory_benchmark_experiment_candidates")).toBe(true);
      const filters = [configuration, fallback].map(
        (target) =>
          `and(experiment_id.eq.${experimentId},definition_revision_id.eq.${sourceRevisionId},qualification_id.eq.${target.qualificationId},worker_runtime.eq.node)`,
      );
      expect(url.searchParams.get("or")).toBe(`(${filters.join(",")})`);
      return Response.json(
        [configuration, fallback].map((target) => ({
          experiment_id: experimentId,
          definition_revision_id: sourceRevisionId,
          definition_digest: source.canonicalDigest,
          qualification_id: target.qualificationId,
          canonical_model_key: target.modelKey,
          harness: target.harness,
          worker_runtime: target.workerRuntime,
        })),
      );
    };
    const client = createClient<Database>("http://factory.test", "test-service-key", {
      auth: { persistSession: false },
      global: { fetch },
    });
    await expect(
      loadQualifiedModelRoutingConfigurations(client, scope, [
        configuration,
        configuration,
        fallback,
        { ...configuration, agentId: otherFactoryId },
        { ...configuration, modelKey: "openai/gpt-incompatible" },
      ]),
    ).resolves.toEqual(qualified);
    expect(queries).toHaveLength(2);
  });
});

describe("compileFactoryDefinition", () => {
  it("keeps the default runtime MCP list explicitly empty without changing the canonical digest", () => {
    const original = compile(candidate());
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    expect(compile({ ...candidate(), mcpBindings: [] })).toEqual(original);
    expect(original.bundle).not.toHaveProperty("mcpManifest");
    expect(runtimeMcpManifest(original.bundle.mcpManifest)).toEqual({ servers: [] });
    expect(
      compiledFactoryDefinitionSchema.safeParse({ ...original.bundle, toolIds: ["unbound"] })
        .success,
    ).toBe(false);
  });

  it("pins the exact reviewed operations and opaque MCP secret reference in canonical order", () => {
    const { input, references } = mcpFixture();
    const compiled = compile(input, references);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(runtimeMcpManifest(compiled.bundle.mcpManifest)).toEqual({
      agentId,
      servers: [
        {
          toolRevisionId: buildMcpRevisionId,
          serverId: buildMcpServerId,
          serverSlug: "build-catalog",
          revisionNumber: 1,
          endpoint: "https://builds.example.test/mcp",
          operations: ["list"],
          auth: { kind: "none" },
        },
        {
          toolRevisionId: docsMcpRevisionId,
          serverId: docsMcpServerId,
          serverSlug: "reference-docs",
          revisionNumber: 2,
          endpoint: "https://docs.example.test/mcp",
          operations: ["Read", "search"],
          auth: { kind: "bearer", secretBindingId: mcpBindingId },
        },
      ],
    });
    const reviewedToolIds = [
      `${buildMcpRevisionId}/list`,
      `${docsMcpRevisionId}/Read`,
      `${docsMcpRevisionId}/search`,
    ];
    expect(compiled.bundle.toolIds).toEqual(reviewedToolIds);
    expect(
      compiledFactoryDefinitionSchema.safeParse({ ...compiled.bundle, toolIds: [] }).success,
    ).toBe(false);
    expect(compiled.definitionJson).not.toContain("workspace_secret_id");
    const mcpSelection = {
      mcpToolRevisionIds: [buildMcpRevisionId, docsMcpRevisionId],
      mcpSecretBindingIds: [mcpBindingId],
      mcpExecutionGrantId: grantId,
    };
    expect(factoryComponentRevisionsForBundle(compiled.bundle)).toMatchObject(mcpSelection);
    expect(factoryComponentRevisionsForSource({ kind: "structured", value: input })).toMatchObject(
      mcpSelection,
    );
    expect(compile(factoryDefinitionFromBundle(compiled.bundle), references)).toEqual(compiled);
    expect(
      recompileStoredFactoryDefinition(
        compiled.definitionJson,
        compiled.canonicalDigest,
        references,
      ),
    ).toEqual(compiled);
    expect(compile({ ...input, mcpBindings: input.mcpBindings.toReversed() }, references)).toEqual(
      compiled,
    );
    expect(
      recompileStoredFactoryDefinition(compiled.definitionJson, compiled.canonicalDigest, {
        ...references,
        tools: references.tools.filter(({ id }) => id !== docsMcpRevisionId),
      }),
    ).toMatchObject({ ok: false });
    expect(
      recompileStoredFactoryDefinition(compiled.definitionJson, compiled.canonicalDigest, {
        ...references,
        tools: references.tools.map((revision) =>
          revision.id === docsMcpRevisionId
            ? { ...revision, endpoint: "https://elsewhere.example.test/mcp" }
            : revision,
        ),
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects operations outside the grant and rejects a stale grant version", () => {
    const { input, references } = mcpFixture();
    expect(
      compile({ ...input, executionGrant: { id: grantId, version: 2 } }, references),
    ).toMatchObject({ ok: false, diagnostics: [{ path: ["executionGrant"] }] });
    expect(
      compile(
        {
          ...input,
          mcpBindings: [{ ...input.mcpBindings[1], operations: ["archive"] }],
        },
        references,
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["mcpBindings", 0, "operations"] }],
    });
    expect(
      compile({ ...input, mcpBindings: [...input.mcpBindings, input.mcpBindings[0]] }, references),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["mcpBindings", 2, "toolRevisionId"] }],
    });
  });

  it("checks the exact secret purpose and rejects raw per-tool credentials", () => {
    const { input, references } = mcpFixture();
    const foreignBinding = {
      id: mcpBindingId,
      workspaceId,
      grantId,
      servicePrincipalId,
      agentId,
      toolRevisionId: buildMcpRevisionId,
    };
    expect(compile(input, { ...references, mcpSecretBindings: [foreignBinding] })).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["mcpBindings", 1, "secretBindingId"] }],
    });
    expect(
      compile(
        {
          ...input,
          credentialBindingId: mcpBindingId,
          mcpBindings: [{ ...input.mcpBindings[1], secretBindingId: undefined }],
        },
        references,
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["mcpBindings", 0, "secretBindingId"] }],
    });
    expect(
      compile(
        {
          ...input,
          mcpBindings: [{ ...input.mcpBindings[1], token: "synthetic-secret" }],
        },
        references,
      ),
    ).toMatchObject({ ok: false });
  });

  it("pins the exact execution grant and preserves it when reopening a saved definition", () => {
    const id = "c5410000-0000-4000-8000-000000000015";
    const result = compile({
      ...candidate(),
      executionGrant: { id: id.toUpperCase(), version: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.executionGrant).toEqual({ id, version: 2 });
    expect(factoryDefinitionFromBundle(result.bundle).executionGrant).toEqual({ id, version: 2 });
    expect(
      recompileStoredFactoryDefinition(result.definitionJson, result.canonicalDigest, catalog),
    ).toEqual(result);
  });

  it("pins ordered exact context documents without adding a whole repository snapshot", () => {
    const contextDocuments = [
      { sourceId: "aa410000-0000-4000-8000-000000000027", revisionId: docsMcpRevisionId },
      { sourceId: "ba410000-0000-4000-8000-000000000028", revisionId: buildMcpRevisionId },
    ];
    const source = { ...candidate(), executionGrant: { id: grantId, version: 3 } };
    const original = compile(source);
    const selected = compile({
      ...source,
      contextDocuments: contextDocuments.map(({ sourceId, revisionId }) => ({
        sourceId: sourceId.toUpperCase(),
        revisionId: revisionId.toUpperCase(),
      })),
    });
    const reversed = compile({ ...source, contextDocuments: contextDocuments.toReversed() });
    if (!original.ok || !selected.ok || !reversed.ok)
      throw new Error("Expected compiled definitions.");

    expect(selected.bundle.contextDocuments).toEqual(contextDocuments);
    expect(selected.bundle.readContextRepositoryIds).toBeUndefined();
    expect(selected.canonicalDigest).not.toBe(reversed.canonicalDigest);
    expect(factoryDefinitionFromBundle(selected.bundle).contextDocuments).toEqual(contextDocuments);
    expect(
      recompileStoredFactoryDefinition(selected.definitionJson, selected.canonicalDigest, catalog),
    ).toMatchObject({ ok: true, canonicalDigest: selected.canonicalDigest });
    expect(compareFactoryDefinitions(original.bundle, selected.bundle).fields).toEqual([
      expect.objectContaining({
        label: "External context documents",
        before: [],
        after: [
          contextDocuments[0].sourceId + " · " + contextDocuments[0].revisionId,
          contextDocuments[1].sourceId + " · " + contextDocuments[1].revisionId,
        ],
      }),
    ]);
    expect(compile({ ...candidate(), contextDocuments })).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["contextDocuments"] }],
    });
    expect(
      compile({ ...source, contextDocuments: [contextDocuments[0], contextDocuments[0]] }),
    ).toMatchObject({ ok: false, diagnostics: [{ path: ["contextDocuments"] }] });
  });

  it.each([
    { executionPolicy: null },
    { writableRepositories: ["wallie/demo"] },
    { executionGrant: { id: repositoryId, version: 0 } },
  ])("requires a versioned grant pin, an exact writer, and a budget revision (%j)", (overrides) => {
    expect(
      compile({
        ...candidate(),
        executionGrant: { id: repositoryId, version: 1 },
        ...overrides,
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ path: expect.arrayContaining(["executionGrant"]) }),
      ]),
    });
  });

  it("pins the default, alternate writable and read-context repository identities", () => {
    const references = {
      ...catalog,
      repositories: [
        ...catalog.repositories,
        { id: otherRepositoryId, workspaceId, aliases: ["wallie/runtime"] },
        { id: docsRepositoryId, workspaceId, aliases: ["wallie/docs"] },
      ],
    };
    const result = compile(
      {
        ...candidate(),
        writableRepositories: ["wallie/runtime"],
        readContextRepositories: ["wallie/docs"],
      },
      references,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(factoryWritableRepositoryIds(result.bundle)).toEqual([repositoryId, otherRepositoryId]);
    expect(result.bundle.readContextRepositoryIds).toEqual([docsRepositoryId]);
    expect(
      recompileStoredFactoryDefinition(result.definitionJson, result.canonicalDigest, references),
    ).toEqual(result);
    expect(
      compiledFactoryDefinitionSchema.safeParse({
        ...result.bundle,
        readContextRepositoryIds: [otherRepositoryId],
      }).success,
    ).toBe(false);
    expect(
      compile({ ...candidate(), writableRepositories: [], readContextRepositories: [] }),
    ).toEqual(compile(candidate()));
  });

  it("rejects cross-purpose duplicates and references outside the eligible catalog", () => {
    const references = {
      ...catalog,
      repositories: [
        ...catalog.repositories,
        { id: otherRepositoryId, workspaceId: otherWorkspaceId },
      ],
    };
    expect(
      compile(
        {
          ...candidate(),
          writableRepositories: ["wallie/demo"],
          readContextRepositories: [repositoryId, otherRepositoryId],
        },
        references,
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        { path: ["writableRepositories", 0], code: "duplicate_repository_binding" },
        { path: ["readContextRepositories", 0], code: "duplicate_repository_binding" },
        { path: ["readContextRepositories", 1], code: "missing_reference" },
      ],
    });
  });

  it("reads selected prompt and skill revisions only from valid structured or JSON sources", () => {
    const value = { ...candidate(), implementationAgent: promptRevisionId.toUpperCase() };
    const revisions = {
      agentPromptRevisionId: promptRevisionId,
      skillRevisionIds: value.skills,
    };
    expect(factoryComponentRevisionsForSource({ kind: "structured", value })).toEqual(revisions);
    expect(
      factoryComponentRevisionsForSource({ kind: "json", text: JSON.stringify(value) }),
    ).toEqual(revisions);
    expect(factoryComponentRevisionsForSource({ kind: "structured", value: candidate() })).toEqual({
      skillRevisionIds: value.skills,
    });
    expect(
      factoryComponentRevisionsForSource({
        kind: "structured",
        value: { ...value, implementationAgent: "invalid-uuid" },
      }),
    ).toEqual({});
    expect(factoryComponentRevisionsForSource({ kind: "json", text: "{" })).toEqual({});
    expect(
      factoryComponentRevisionsForSource({
        kind: "json",
        text: '{"implementationAgent":"one","implementationAgent":"two"}',
      }),
    ).toEqual({});
  });

  it("does not compile a skill binding that the current catalog does not offer", () => {
    const revisionId = "81b90000-0000-4000-8000-000000000035";
    const source = { ...candidate(), skills: [revisionId] };
    const available = { ...catalog, skills: [{ id: revisionId, workspaceId }] };
    const initial = compile(source, available);
    expect(initial).toMatchObject({ ok: true, bundle: { skillIds: [revisionId] } });
    expect(compile(source, { ...catalog, skills: [] })).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["skills", 0], code: "missing_reference" }],
    });
  });

  it("pins named-agent prompt bytes and keeps template-looking instructions literal", () => {
    const promptMd =
      "Use {{session.prompt}} and {{artifact.previousStages.future-stage}} literally.";
    const prompt = {
      id: promptRevisionId,
      workspaceId,
      agentId,
      promptRevisionId,
      promptMd,
      promptSha256: createHash("sha256").update(promptMd, "utf8").digest("hex"),
    };
    const references = { ...catalog, agentPromptRevisions: [prompt] };
    const compiled = compile({ ...candidate(), implementationAgent: promptRevisionId }, references);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.bundle.implementationAgent).toEqual({
      agentId,
      promptRevisionId,
      promptMd,
      promptSha256: prompt.promptSha256,
    });
    expect(factoryDefinitionFromBundle(compiled.bundle).implementationAgent).toBe(promptRevisionId);
    const updatedCatalog = {
      ...references,
      agentPromptRevisions: [
        prompt,
        {
          ...prompt,
          id: otherRepositoryId,
          promptRevisionId: otherRepositoryId,
          promptMd: "New candidate",
        },
      ],
    };
    expect(
      recompileStoredFactoryDefinition(
        compiled.definitionJson,
        compiled.canonicalDigest,
        updatedCatalog,
      ),
    ).toEqual(compiled);
  });

  it("keeps only the opaque service binding reference in the canonical definition", () => {
    const bindingId = "c5410000-0000-4000-8000-000000000018";
    const promptMd = "Review the workspace task.";
    const references = {
      ...catalog,
      agentPromptRevisions: [
        {
          id: promptRevisionId,
          workspaceId,
          agentId,
          promptRevisionId,
          promptMd,
          promptSha256: createHash("sha256").update(promptMd, "utf8").digest("hex"),
        },
      ],
    };
    const source = {
      ...candidate(),
      implementationAgent: promptRevisionId,
      executionGrant: { id: agentId, version: 1 },
      credentialBindingId: bindingId.toUpperCase(),
    };
    const compiled = compile(source, references);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.bundle.credentialBindingId).toBe(bindingId);
    expect(factoryDefinitionFromBundle(compiled.bundle).credentialBindingId).toBe(bindingId);
    expect(
      recompileStoredFactoryDefinition(
        compiled.definitionJson,
        compiled.canonicalDigest,
        references,
      ),
    ).toEqual(compiled);
    expect(compile({ ...source, credentialValue: "synthetic-secret" }, references)).toMatchObject({
      ok: false,
    });
    expect(compile({ ...source, implementationAgent: undefined }, references)).toMatchObject({
      ok: false,
    });
    expect(compile({ ...source, executionGrant: undefined }, references)).toMatchObject({
      ok: false,
    });
  });

  it("rejects missing or foreign agent prompts and caller-supplied prompt authority", () => {
    const promptMd = "Trusted instructions";
    const foreign = {
      id: promptRevisionId,
      workspaceId: otherWorkspaceId,
      agentId,
      promptRevisionId,
      promptMd,
      promptSha256: createHash("sha256").update(promptMd, "utf8").digest("hex"),
    };
    expect(
      compile(
        { ...candidate(), implementationAgent: promptRevisionId },
        {
          ...catalog,
          agentPromptRevisions: [foreign],
        },
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["implementationAgent"], code: "missing_reference" }],
    });
    expect(
      compile({ ...candidate(), implementationAgent: { ...foreign, authority: "owner" } }),
    ).toMatchObject({ ok: false });
    const original = compile(candidate());
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    expect(original.definitionJson).not.toContain("implementationAgent");
    expect(
      recompileStoredFactoryDefinition(original.definitionJson, original.canonicalDigest, {
        ...catalog,
        agentPromptRevisions: [],
      }),
    ).toEqual(original);
  });

  it("compiles structured and JSON inputs into the same stable IDs, canonical bytes, and digest", () => {
    const input = candidate();
    input.agent.maxRetries = -0;
    const byId = {
      ...input,
      repository: repositoryId.toUpperCase(),
      pipeline: pipelineId,
      executionPolicy: executionPolicyId,
      deliveryPolicy: deliveryPolicyId,
      agent: { ...input.agent, provider: "claude-code" },
      skills: ["proof@2", "review@1", "Review"],
      stages: input.stages.map(({ id, approverMemberIds, ...stage }) => ({
        ...stage,
        id: id.toUpperCase(),
        approverMemberIds: approverMemberIds?.toReversed(),
      })),
    };
    const result = compile(input);
    const fromFile = compileFactoryDefinition(
      { kind: "json", text: JSON.stringify(byId, null, 2) },
      catalog,
    );
    expect(result.ok).toBe(true);
    expect(fromFile).toEqual(result);
    if (!result.ok) return;
    expect(result.bundle).toMatchObject({
      schemaVersion: 1,
      kind: "serial",
      pipelineId,
      repositoryId,
      executionPolicyRevisionId: executionPolicyId,
      deliveryPolicyRevisionId: deliveryPolicyId,
      skillIds: ["proof@2", "review@1"],
      toolIds: [],
      operatingRuleStageIds: [firstStageId],
      stages: [
        { id: firstStageId, name: "Découvrir les risques", previousStageIds: [] },
        {
          id: lastStageId,
          approverMemberIds: [approverId, otherApproverId],
          previousStageIds: [firstStageId],
        },
      ],
    });
    expect(JSON.parse(result.definitionJson)).toEqual(result.bundle);
    expect(result.canonicalDigest).toBe(
      createHash("sha256").update(result.definitionJson, "utf8").digest("hex"),
    );
  });

  it("preserves custom stage order as part of definition identity", () => {
    const input = candidate();
    const stages = input.stages.map((stage) => ({
      ...stage,
      promptTemplateMd: "Keep exact line endings.\n",
    }));
    const a = compile({ ...input, stages });
    const b = compile({ ...input, stages: stages.toReversed() });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.bundle.stages.map((stage) => stage.id)).toEqual([lastStageId, firstStageId]);
    expect(a.canonicalDigest).not.toBe(b.canonicalDigest);
  });

  it("pins version 2 scorer revisions in canonical order and round-trips stored bytes", () => {
    const revisions = [scorerRevisionId, laterScorerRevisionId];
    const references = {
      ...catalog,
      factoryId,
      scorerRevisions: revisions.map((id) => ({ id, workspaceId, factoryId })),
    };
    const source = {
      ...candidate(),
      schemaVersion: 2,
      scorerRevisionIds: [laterScorerRevisionId, scorerRevisionId.toUpperCase()],
    };
    const compiled = compile(source, references);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.bundle).toMatchObject({ schemaVersion: 2, scorerRevisionIds: revisions });
    expect(compile({ ...source, scorerRevisionIds: revisions }, references)).toEqual(compiled);
    expect(factoryComponentRevisionsForSource({ kind: "structured", value: source })).toMatchObject(
      { scorerRevisionIds: revisions.toReversed() },
    );
    expect(factoryComponentRevisionsForBundle(compiled.bundle)).toMatchObject({
      scorerRevisionIds: revisions,
    });
    expect(
      recompileStoredFactoryDefinition(
        compiled.definitionJson,
        compiled.canonicalDigest,
        references,
      ),
    ).toEqual(compiled);
    expect(
      compiledFactoryDefinitionSchema.safeParse({
        ...compiled.bundle,
        scorerRevisionIds: revisions.toReversed(),
      }).success,
    ).toBe(false);
  });

  it("checks the scorer revision shape and schema version before resolving anything", () => {
    const old = candidate();
    const next = { ...old, schemaVersion: 2 };
    expect(compile(old)).toMatchObject({ ok: true });
    expect(compile({ ...next, scorerRevisionIds: [] })).toMatchObject({ ok: true });
    for (const test of [
      { value: { ...old, scorerRevisionIds: [] }, path: ["scorerRevisionIds"] },
      { value: next, path: ["scorerRevisionIds"] },
      { value: { ...next, scorerRevisionIds: ["current"] }, path: ["scorerRevisionIds", 0] },
      {
        value: { ...next, scorerRevisionIds: [scorerRevisionId, scorerRevisionId.toUpperCase()] },
        path: ["scorerRevisionIds", 1],
      },
      {
        value: {
          ...next,
          scorerRevisionIds: Array.from(
            { length: 33 },
            (_, i) => "c5410000-0000-4000-8000-" + String(i).padStart(12, "0"),
          ),
        },
        path: ["scorerRevisionIds"],
      },
    ]) {
      expect(compile(test.value)).toMatchObject({
        ok: false,
        diagnostics: [{ path: test.path, code: "invalid_schema" }],
      });
    }
  });

  it("cannot bind a scorer revision from another factory or workspace, or use an alias", () => {
    const source = { ...candidate(), schemaVersion: 2, scorerRevisionIds: [scorerRevisionId] };
    const references = {
      ...catalog,
      factoryId,
      scorerRevisions: [
        { id: scorerRevisionId, workspaceId, factoryId: otherFactoryId },
        { id: scorerRevisionId, workspaceId: otherWorkspaceId, factoryId },
        { id: laterScorerRevisionId, workspaceId, factoryId, aliases: [scorerRevisionId] },
      ],
    };
    expect(compile(source, references)).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["scorerRevisionIds", 0], code: "missing_reference" }],
    });
  });

  it("does not put catalog aliases, authority, or operational readiness in the definition identity", () => {
    const input = {
      ...candidate(),
      pipeline: pipelineId,
      repository: repositoryId,
      skills: [],
      tools: [],
      executionPolicy: null,
      deliveryPolicy: null,
    };
    const a = compile(input);
    const b = compile(input, {
      ...catalog,
      pipelines: [{ id: pipelineId, workspaceId, aliases: ["New label"] }],
      repositories: [{ id: repositoryId, workspaceId, aliases: ["new/repo"] }],
      sandboxProviders: ["e2b", "vercel"],
      skills: [],
      tools: [],
    });
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
  });

  it("identifies missing, foreign, ambiguous, and unsupported references at their fields", () => {
    const input = candidate();
    const result = compile(
      {
        ...input,
        sandboxProvider: "e2b",
        agent: { ...input.agent, provider: "cursor", model: "opencode/gpt-model" },
        tools: ["Files"],
        stages: [input.stages[0], { ...input.stages[1], approverMemberIds: [otherApproverId] }],
      },
      {
        ...catalog,
        pipelines: [
          { id: pipelineId, workspaceId: otherWorkspaceId, aliases: ["Delivery pipeline"] },
        ],
        repositories: [
          ...catalog.repositories,
          { id: otherRepositoryId, workspaceId, aliases: ["wallie/demo"] },
        ],
        executionPolicyRevisions: [],
        approvers: [{ id: otherApproverId, workspaceId: otherWorkspaceId }],
      },
    );
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        {
          path: ["pipeline"],
          code: "missing_reference",
          message: expect.stringContaining("Choose an available"),
        },
        {
          path: ["repository"],
          code: "ambiguous_reference",
          message: expect.stringContaining("Use a unique stable ID"),
        },
        { path: ["executionPolicy"], code: "missing_reference", message: expect.any(String) },
        { path: ["sandboxProvider"], code: "unsupported_capability", message: expect.any(String) },
        { path: ["agent", "model"], code: "unsupported_capability", message: expect.any(String) },
        { path: ["agent", "effort"], code: "unsupported_capability", message: expect.any(String) },
        { path: ["skills", 1], code: "unsupported_capability", message: expect.any(String) },
        { path: ["tools"], code: "unsupported_capability", message: expect.any(String) },
        {
          path: ["stages", 1, "approverMemberIds", 0],
          code: "missing_reference",
          message: expect.any(String),
        },
      ]),
    });
  });

  it("requires delivery policy revisions to match the selected pipeline", () => {
    expect(
      compile(candidate(), {
        ...catalog,
        deliveryPolicyRevisions: [
          { ...catalog.deliveryPolicyRevisions[0], pipelineId: lastStageId },
        ],
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["deliveryPolicy"], code: "unsupported_capability" }],
    });
  });

  it("reports forward, self, and unknown artifact references", () => {
    const input = candidate();
    input.stages[0].promptTemplateMd =
      "{{artifact.previousStages.prepare-release}} {{artifact.previousStages.discover-risk}} {{artifact.previousStages.unknown-stage}}";
    const compiled = compile(input);
    expect(compiled).toMatchObject({
      ok: false,
      diagnostics: [
        {
          path: ["stages", 0, "promptTemplateMd"],
          code: "unreachable_stage",
          message: expect.stringContaining("prepare-release"),
        },
        {
          path: ["stages", 0, "promptTemplateMd"],
          code: "unreachable_stage",
          message: expect.stringContaining("discover-risk"),
        },
        {
          path: ["stages", 0, "promptTemplateMd"],
          code: "missing_reference",
          message: expect.stringContaining("unknown-stage"),
        },
      ],
    });
  });

  it("preserves owner and admin approval when no specific approvers are assigned", () => {
    const input = candidate();
    input.stages[0].anyoneCanApprove = false;
    expect(compile(input)).toMatchObject({
      ok: true,
      bundle: {
        stages: [
          { id: firstStageId, anyoneCanApprove: false, approverMemberIds: [] },
          {
            id: lastStageId,
            anyoneCanApprove: false,
            approverMemberIds: [approverId, otherApproverId],
          },
        ],
      },
    });
  });

  it("rejects duplicate stable IDs and slugs regardless of display name", () => {
    const input = candidate();
    input.stages[1].id = firstStageId.toUpperCase();
    input.stages[1].slug = input.stages[0].slug;
    expect(compile(input)).toMatchObject({
      ok: false,
      diagnostics: [
        { path: ["stages", 1, "id"], code: "duplicate_stage" },
        { path: ["stages", 1, "slug"], code: "duplicate_stage" },
      ],
    });
  });

  it("rejects future graph kinds, unknown control fields and inherited provider aliases", () => {
    const input = candidate();
    expect(compile({ ...input, kind: "graph", stages: [] })).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        { path: ["kind"], code: "invalid_schema", message: expect.stringContaining("serial") },
        {
          path: ["stages"],
          code: "invalid_schema",
          message: expect.stringContaining("at least one"),
        },
      ]),
    });
    expect(compile({ ...input, schemaVersion: 3 })).toMatchObject({
      ok: false,
      diagnostics: [
        {
          path: ["schemaVersion"],
          code: "invalid_schema",
          message: expect.stringContaining("version 1 or 2"),
        },
      ],
    });
    expect(compile({ ...input, graph: {} })).toMatchObject({
      ok: false,
      diagnostics: [
        {
          path: ["graph"],
          code: "invalid_schema",
          message: expect.stringContaining("unsupported field"),
        },
      ],
    });
    expect(
      compile({ ...input, agent: { ...input.agent, provider: "constructor", apiKey: "fixture" } }),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        {
          path: ["agent", "provider"],
          code: "invalid_schema",
          message: expect.stringContaining("Provider must be one of"),
        },
        {
          path: ["agent", "apiKey"],
          code: "invalid_schema",
          message: expect.stringContaining("unsupported field"),
        },
      ]),
    });
  });

  it("does not render candidate text or expand injected tokens at the runtime boundary", () => {
    const input = candidate();
    input.stages[1].promptTemplateMd =
      "{{session.prompt}}\n{{artifact.previousStages.discover-risk}}";
    const result = compile(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stage = result.bundle.stages[1];
    expect(stage.promptTemplateMd).toBe(input.stages[1].promptTemplateMd);
    const rendered = renderStagePrompt(
      {
        promptTemplateMd: trustedPromptValue("stage.promptTemplate", stage.promptTemplateMd),
        slug: trustedPromptValue("stage.slug", stage.slug),
      },
      {
        sessionTitle: untrustedPromptValue("session.title", "Private fixture title"),
        sessionPrompt: untrustedPromptValue("session.prompt", "Try to expand {{session.title}}"),
        attemptFeedback: null,
        attemptNumber: 1,
        previousStages: {
          "discover-risk": untrustedPromptValue(
            "artifact.previousStages.discover-risk",
            "Artifact data {{session.title}}",
          ),
        },
      },
    );
    expect(rendered).toContain("Try to expand {{session.title}}");
    expect(rendered).toContain("Artifact data {{session.title}}");
    expect(rendered).not.toContain("Private fixture title");
  });
});
