import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadFactoryDefinitionCatalog } from "@/lib/factory-definitions/authority";
import { compileFactoryDefinition } from "@/lib/factory-definitions/compiler";
import type { FactoryDefinitionCatalog } from "@/lib/factory-definitions/references";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import {
  modelRoutingPolicySchema,
  type ModelRoutingConfiguration,
} from "@/lib/model-routing/contracts";
import type { Database } from "@/lib/supabase/database.types";

import { factoryProposalCommandSchema, type FactoryProposalEdit } from "./contracts";
import { compileFactoryProposal } from "./patch";

vi.mock("@/lib/factory-definitions/authority", () => ({ loadFactoryDefinitionCatalog: vi.fn() }));

const id = (suffix: number) => `66a00000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const workspaceId = id(1);
const factoryId = id(2);
const pipeline = id(3);
const repository = id(4);
const approver = id(5);
const plan = id(6);
const build = id(7);
const agentId = id(8);
const prompt = id(9);
const nextPrompt = id(10);
const skillId = id(11);
const skill = id(12);
const nextSkill = id(13);
const scorerId = id(14);
const scorer = id(15);
const nextScorer = id(16);
const ruleId = id(17);
const taskClassId = id(18);

const originalRouting: ModelRoutingConfiguration = {
  agentId,
  definitionRevisionId: id(19),
  experimentId: id(20),
  qualificationId: id(21),
  modelKey: "anthropic/claude-sonnet-4-6",
  harness: "claude-code",
  workerRuntime: "workerd",
};
const newRouting: ModelRoutingConfiguration = {
  ...originalRouting,
  definitionRevisionId: id(22),
  qualificationId: id(23),
  modelKey: "anthropic/claude-haiku-4-5",
};
const modelRouting = modelRoutingPolicySchema.parse({
  version: 1,
  taskClasses: [{ id: taskClassId, slug: "maintenance", name: "Maintenance" }],
  rules: [
    {
      id: ruleId,
      taskClassId,
      configuration: originalRouting,
      constraints: {
        qualityFloorBps: 9000,
        maxMeanCostUsd: null,
        maxLatencyMs: null,
        minResolvedTrials: 2,
        minConfidenceBps: null,
      },
      onUnavailable: { kind: "escalate" },
    },
  ],
  onUnmatched: { kind: "escalate" },
});

const catalog: FactoryDefinitionCatalog = {
  workspaceId,
  factoryId,
  pipelines: [{ id: pipeline, workspaceId }],
  repositories: [{ id: repository, workspaceId }],
  executionPolicyRevisions: [],
  deliveryPolicyRevisions: [],
  skills: [skill, nextSkill].map((id) => ({ id, workspaceId })),
  scorerRevisions: [scorer, nextScorer].map((id) => ({ id, workspaceId, factoryId })),
  tools: [],
  approvers: [{ id: approver, workspaceId }],
  sandboxProviders: ["vercel"],
  agentPromptRevisions: [prompt, nextPrompt].map((id, version) => ({
    id,
    workspaceId,
    agentId,
    promptRevisionId: id,
    promptMd: `Prompt ${version}`,
    promptSha256: hash(`Prompt ${version}`),
  })),
  modelRoutingConfigurations: [originalRouting, newRouting].map((configuration) => ({
    ...configuration,
    workspaceId,
    factoryId,
  })),
};

const source = {
  schemaVersion: 2,
  kind: "serial",
  pipeline,
  repository,
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
  implementationAgent: prompt,
  skills: [skill],
  scorerRevisionIds: [scorer],
  stages: [
    {
      id: plan,
      slug: "plan",
      name: "Plan",
      promptTemplateMd: "Inspect the report.",
      approverMemberIds: [approver],
    },
    {
      id: build,
      slug: "build",
      name: "Build",
      promptTemplateMd: "Make the change.",
      approverMemberIds: [approver],
    },
  ],
};

function fixture(value: unknown) {
  const compiled = compileFactoryDefinition({ kind: "structured", value }, catalog);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled;
}

const base = fixture({ ...source, modelRouting });
const routeTarget = fixture({ ...source, skills: [nextSkill] });
const grant = {
  stageIds: [plan, build],
  agentIds: [agentId],
  skillRevisionIds: [skill],
  scorerRevisionIds: [scorer],
  routingRuleIds: [ruleId],
};
const edits: FactoryProposalEdit[] = [
  {
    kind: "stage_prompt",
    stageId: plan,
    expectedPromptSha256: hash("Inspect the report."),
    promptTemplateMd: "Inspect the report and check the source.",
  },
  { kind: "agent_prompt", agentId, fromRevisionId: prompt, toRevisionId: nextPrompt },
  { kind: "skill_revision", skillId, fromRevisionId: skill, toRevisionId: nextSkill },
  { kind: "workflow_order", fromStageIds: [plan, build], toStageIds: [build, plan] },
  { kind: "scorer_revision", scorerId, fromRevisionId: scorer, toRevisionId: nextScorer },
  { kind: "routing_target", ruleId, from: originalRouting, to: newRouting },
];

function client({
  differentSkill = false,
  target = routeTarget,
}: { differentSkill?: boolean; target?: typeof routeTarget } = {}) {
  return createClient<Database>("https://factory.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (input) => {
        const { pathname } = new URL(String(input));
        switch (pathname) {
          case "/rest/v1/factory_skill_revisions":
            return Response.json([
              { id: skill, skill_id: skillId, revoked_at: "2026-11-21T00:00:00Z" },
              { id: nextSkill, skill_id: differentSkill ? id(24) : skillId, revoked_at: null },
            ]);
          case "/rest/v1/factory_scorer_revisions":
            return Response.json([
              { id: scorer, scorer_id: scorerId },
              { id: nextScorer, scorer_id: scorerId },
            ]);
          case "/rest/v1/factory_definition_revisions":
            return Response.json([
              {
                id: newRouting.definitionRevisionId,
                canonical_digest: target.canonicalDigest,
                definition_json: target.definitionJson,
              },
            ]);
          default:
            throw new Error(`Unexpected fixture request ${pathname}`);
        }
      },
    },
  });
}

describe("scoped factory proposal compilation", () => {
  beforeEach(() => vi.mocked(loadFactoryDefinitionCatalog).mockResolvedValue(catalog));

  it("reproduces every supported edit against verified bytes while preserving unrelated configuration", async () => {
    const exactBase = readVerifiedFactoryDefinition(base.definitionJson, base.canonicalDigest);
    expect(exactBase).toEqual(base.bundle);
    const input = { client: client(), workspaceId, factoryId, base: exactBase!, grant, edits };
    const compiled = await compileFactoryProposal(input);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(await compileFactoryProposal(input)).toEqual(compiled);
    const candidate = readVerifiedFactoryDefinition(
      compiled.definitionJson,
      compiled.canonicalDigest,
    );
    expect(candidate).toMatchObject({
      repositoryId: repository,
      pipelineId: pipeline,
      implementationAgent: { agentId, promptRevisionId: nextPrompt },
      skillIds: [nextSkill],
      scorerRevisionIds: [nextScorer],
      stages: [
        { id: build, approverMemberIds: [approver] },
        {
          id: plan,
          approverMemberIds: [approver],
          promptTemplateMd: "Inspect the report and check the source.",
        },
      ],
      modelRouting: {
        rules: [{ id: ruleId, configuration: newRouting, onUnavailable: { kind: "escalate" } }],
      },
    });
    expect(compiled.canonicalDigest).not.toBe(base.canonicalDigest);
    expect(compiled.diff.fields.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "Agent prompt revision",
        "Skills",
        "Scorers",
        "Model routing policy",
      ]),
    );
    expect(compiled.diff.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: plan, orderChanged: true })]),
    );
  });

  it("refuses unauthorized stages, unrelated component families, and routing scope expansion", async () => {
    const input = { workspaceId, factoryId, base: base.bundle, grant, edits };
    expect(
      await compileFactoryProposal({
        ...input,
        client: client(),
        grant: { ...grant, stageIds: [] },
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ path: ["edits", 0] }] });
    expect(
      await compileFactoryProposal({ ...input, client: client({ differentSkill: true }) }),
    ).toMatchObject({ ok: false, diagnostics: [{ path: ["skills"] }] });
    expect(
      await compileFactoryProposal({ ...input, client: client({ target: fixture(source) }) }),
    ).toMatchObject({ ok: false, diagnostics: [{ path: ["modelRouting"] }] });
  });

  it("retains compiler errors when a stage prompt uses a nonpreceding stage", async () => {
    const invalidPrompt = {
      kind: "stage_prompt",
      stageId: plan,
      expectedPromptSha256: hash("Inspect the report."),
      promptTemplateMd: "Use {{artifact.previousStages.build}}.",
    } as const;
    const result = await compileFactoryProposal({
      client: client(),
      workspaceId,
      factoryId,
      base: base.bundle,
      grant,
      edits: [invalidPrompt],
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ path: ["stages", 0, "promptTemplateMd"], code: "unreachable_stage" }],
    });
  });

  it("rejects protected fields, aliases, and duplicate edit targets in the incoming command", () => {
    const command = {
      requestId: id(25),
      diagnosisId: id(26),
      base: { activationNumber: 1, revisionId: id(27), digest: base.canonicalDigest },
      rationale: "Investigate evidence reporting",
      expectedBenefit: "Earlier visibility into failures",
    };
    expect(factoryProposalCommandSchema.safeParse({ ...command, edits }).success).toBe(true);
    expect(
      factoryProposalCommandSchema.safeParse({ ...command, edits: [{ ...edits[0], repository }] })
        .success,
    ).toBe(false);
    expect(
      factoryProposalCommandSchema.safeParse({
        ...command,
        edits: [{ ...edits[2], toRevisionId: "skill-head" }],
      }).success,
    ).toBe(false);
    expect(
      factoryProposalCommandSchema.safeParse({ ...command, edits: [edits[0], edits[0]] }).success,
    ).toBe(false);
  });
});
