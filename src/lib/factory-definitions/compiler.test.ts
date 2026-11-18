import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import { renderStagePrompt } from "@/lib/prompt-templates";

import { compileFactoryDefinition, factoryComponentRevisionsForSource } from "./compiler";
import type { FactoryDefinitionCatalog } from "./references";
import { compiledFactoryDefinitionSchema, type SerialFactoryDefinitionInput } from "./schema";
import { factoryWritableRepositoryIds } from "./repository-bindings";
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
  tools: [
    { id: "workspace-files@1", workspaceId, aliases: ["Files"], agentProviders: ["claude-code"] },
  ],
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
    tools: ["Files"],
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

describe("compileFactoryDefinition", () => {
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
      tools: ["workspace-files@1"],
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
      toolIds: ["workspace-files@1"],
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
        { path: ["tools", 0], code: "unsupported_capability", message: expect.any(String) },
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
    expect(compile({ ...input, schemaVersion: 2, graph: {} })).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        {
          path: ["schemaVersion"],
          code: "invalid_schema",
          message: expect.stringContaining("version 1"),
        },
        {
          path: ["graph"],
          code: "invalid_schema",
          message: expect.stringContaining("unsupported field"),
        },
      ]),
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
