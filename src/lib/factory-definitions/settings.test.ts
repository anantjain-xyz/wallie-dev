import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compileFactoryDefinition } from "@/lib/factory-definitions/compiler";
import type { FactoryDefinitionCatalog } from "@/lib/factory-definitions/references";
import {
  loadSettingsFactoryDefinitionState,
  mutateSettingsFactoryDefinition,
} from "@/lib/factory-definitions/settings";
import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({
  loadCatalog: vi.fn(),
  loadDefaultPipeline: vi.fn(),
  loadPipelineByDefinition: vi.fn(),
  mutateFactoryDefinition: vi.fn(),
}));

vi.mock("@/lib/factory-definitions/authority", () => ({
  loadFactoryDefinitionCatalog: mocks.loadCatalog,
  factoryActivationRequirements: vi.fn(() => ({
    enabledSandboxProviders: ["vercel", "e2b"],
    requiredProbes: ["git"],
  })),
}));

vi.mock("@/lib/pipeline/stages", () => ({
  loadDefaultPipelineConfigurationForWorkspace: mocks.loadDefaultPipeline,
  loadPipelineConfigurationWithStages: mocks.loadPipelineByDefinition,
}));

vi.mock("@/lib/factory-definitions/mutations", () => ({
  mutateFactoryDefinition: mocks.mutateFactoryDefinition,
}));

const workspaceId = "54500000-0001-4000-8000-000000000001";
const factoryId = "54500000-0001-4000-8000-000000000002";
const actorUserId = "54500000-0001-4000-8000-000000000003";
const pipelineId = "54500000-0001-4000-8000-000000000004";
const repositoryId = "54500000-0001-4000-8000-000000000005";
const stageId = "54500000-0001-4000-8000-000000000006";
const revisionId = "54500000-0001-4000-8000-000000000008";
const draftId = "54500000-0001-4000-8000-000000000009";
const executionPolicyId = "54500000-0001-4000-8000-000000000010";
const deliveryPolicyId = "54500000-0001-4000-8000-000000000011";
const memberId = "54500000-0001-4000-8000-000000000012";
const now = "2026-11-15T20:00:00.000Z";

const catalog: FactoryDefinitionCatalog = {
  workspaceId,
  pipelines: [{ id: pipelineId, workspaceId, aliases: ["Default"] }],
  repositories: [{ id: repositoryId, workspaceId, aliases: ["acme/app"] }],
  executionPolicyRevisions: [{ id: executionPolicyId, workspaceId }],
  deliveryPolicyRevisions: [{ id: deliveryPolicyId, workspaceId, pipelineId }],
  skills: [],
  tools: [],
  approvers: [{ id: memberId, workspaceId }],
  sandboxProviders: ["vercel", "e2b"],
};

const compiledActive = compileFactoryDefinition(
  {
    kind: "structured",
    value: {
      schemaVersion: 1,
      kind: "serial",
      pipeline: pipelineId,
      repository: repositoryId,
      sandboxProvider: "vercel",
      agent: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        concurrencyLimit: 1,
        stallTimeoutMs: 900_000,
        maxRetries: 3,
        maxTurns: 5,
      },
      executionPolicy: executionPolicyId,
      deliveryPolicy: deliveryPolicyId,
      operatingRulesMd: "Published rules.",
      stages: [
        {
          id: stageId,
          slug: "plan",
          name: "Plan",
          description: "Plan work",
          promptTemplateMd: "Plan {{session.prompt}}.",
          anyoneCanApprove: false,
          approverMemberIds: [memberId],
        },
      ],
    },
  },
  catalog,
);
if (!compiledActive.ok) throw new Error("Fixture failed to compile.");
const compiledFixture = compiledActive;

const defaultPipelineConfig = {
  id: pipelineId,
  isDefault: true,
  name: "Default",
  operatingRulesMd: "Published rules.",
  archivedStages: [],
  stages: [
    {
      id: stageId,
      pipelineId,
      position: 1,
      slug: "plan",
      name: "Plan",
      description: "Plan work",
      promptTemplateMd: "Plan {{session.prompt}}.",
      anyoneCanApprove: false,
      approverMemberIds: [memberId],
    },
  ],
};

function makeClient(
  handler: (req: { method: string; url: URL; body?: unknown }) => Response | Promise<Response>,
) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return handler({ method, url, body });
  });
  return {
    admin: createClient<Database>("http://localhost:9999", "test-service-role", {
      global: { fetch },
    }),
    fetch,
  };
}

function defaultStateResponder(options?: {
  activationNumber?: number;
  draft?: { id: string; definition_json: string; canonical_digest: string } | null;
  extraHandler?: (req: { method: string; url: URL; body?: unknown }) => Response | null;
}) {
  const activationNumber = options?.activationNumber ?? 1;
  const draft = options?.draft ?? null;
  return ({ method, url, body }: { method: string; url: URL; body?: unknown }) => {
    const custom = options?.extraHandler?.({ method, url, body });
    if (custom) return custom;

    if (url.pathname.endsWith("/factories")) return Response.json([{ id: factoryId }]);
    if (url.pathname.endsWith("/pipelines") && method === "GET") {
      return Response.json([{ id: pipelineId }]);
    }
    if (url.pathname.endsWith("/execution_policies")) {
      return Response.json([{ current_revision_id: executionPolicyId, revision: 1 }]);
    }
    if (url.pathname.endsWith("/delivery_policies")) {
      return Response.json([{ current_revision_id: deliveryPolicyId, revision: 1 }]);
    }
    if (url.pathname.endsWith("/factory_definition_activations")) {
      if (activationNumber === 0) return Response.json([]);
      return Response.json([
        {
          id: "activation-1",
          revision_id: revisionId,
          activation_number: activationNumber,
          previous_activation_number: activationNumber > 1 ? activationNumber - 1 : null,
          created_at: now,
        },
      ]);
    }
    if (url.pathname.endsWith("/factory_definition_revisions")) {
      return Response.json([
        {
          id: revisionId,
          definition_json: compiledFixture.definitionJson,
          canonical_digest: compiledFixture.canonicalDigest,
          created_at: now,
        },
      ]);
    }
    if (url.pathname.endsWith("/factory_definition_drafts")) {
      if (!draft) return Response.json([]);
      return Response.json([
        {
          id: draft.id,
          base_activation_number: activationNumber || null,
          schema_version: 1,
          definition_json: draft.definition_json,
          canonical_digest: draft.canonical_digest,
          created_at: now,
        },
      ]);
    }
    if (url.pathname.endsWith("/execution_policy_revisions")) {
      return Response.json([
        {
          id: executionPolicyId,
          workspace_id: workspaceId,
          revision: 1,
          created_at: now,
          requirements: {
            version: 1,
            maxRepairAttempts: 3,
            maxExecutionMs: 3_600_000,
            maxTotalTokens: null,
            maxCostUsd: null,
          },
        },
      ]);
    }
    if (url.pathname.endsWith("/delivery_policy_revisions")) {
      return Response.json([
        {
          id: deliveryPolicyId,
          workspace_id: workspaceId,
          pipeline_id: pipelineId,
          revision: 1,
          created_at: now,
          requirements: {
            version: 1,
            deliveryMode: "code",
            requiredChecks: [],
            minimumApprovals: 0,
            requireCodeOwnerReview: false,
            requireResolvedThreads: true,
            requiredEvidence: [],
            freshnessSeconds: 3600,
            requireArtifactApprovalForDelivery: false,
          },
        },
      ]);
    }
    if (url.pathname.endsWith("/github_installations")) {
      return Response.json([{ id: "install-1" }]);
    }
    if (url.pathname.endsWith("/github_repositories")) {
      return Response.json([{ id: repositoryId, github_installation_id: "install-1" }]);
    }
    if (url.pathname.endsWith("/workspace_onboarding")) {
      return Response.json([{ selected_github_repository_id: repositoryId }]);
    }
    if (url.pathname.endsWith("/workspace_repository_profiles")) {
      return Response.json([]);
    }
    return Response.json([]);
  };
}

describe("factory definition Settings loader & mutations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadCatalog.mockResolvedValue(catalog);
    mocks.loadDefaultPipeline.mockResolvedValue(defaultPipelineConfig);
    mocks.loadPipelineByDefinition.mockResolvedValue(defaultPipelineConfig);
  });

  it("loads the active revision and matching unpublished draft with pinned policies", async () => {
    const draftDef = compileFactoryDefinition(
      {
        kind: "structured",
        value: {
          schemaVersion: 1,
          kind: "serial",
          pipeline: pipelineId,
          repository: repositoryId,
          sandboxProvider: "e2b",
          agent: {
            provider: "codex",
            model: "gpt-5.6",
            effort: "high",
            concurrencyLimit: 2,
            stallTimeoutMs: 900_000,
            maxRetries: 4,
            maxTurns: 5,
          },
          executionPolicy: executionPolicyId,
          deliveryPolicy: deliveryPolicyId,
          operatingRulesMd: "Draft rules.",
          stages: [
            {
              id: stageId,
              slug: "plan",
              name: "Plan",
              description: "Plan work",
              promptTemplateMd: "Draft prompt.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
          ],
        },
      },
      catalog,
    );
    if (!draftDef.ok) throw new Error("Draft failed to compile.");

    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        draft: {
          id: draftId,
          definition_json: draftDef.definitionJson,
          canonical_digest: draftDef.canonicalDigest,
        },
      }),
    );

    const state = await loadSettingsFactoryDefinitionState(admin, workspaceId);
    expect(state.expectedActivationNumber).toBe(1);
    expect(state.currentActivation?.activationNumber).toBe(1);
    expect(state.latestDraft?.id).toBe(draftId);
    expect(state.activeDefinition?.agent.model).toBe("gpt-5.6");
    expect(state.activeDefinition?.sandboxProvider).toBe("e2b");
    expect(state.executionPolicy?.id).toBe(executionPolicyId);
    expect(state.deliveryPolicy?.id).toBe(deliveryPolicyId);
  });

  it("loads liveDeliveryPolicyRevision for the active definition pipeline when it differs from the default pipeline", async () => {
    const otherPipelineId = "54500000-0001-4000-8000-000000000044";
    const otherDeliveryPolicyId = "54500000-0001-4000-8000-000000000045";
    const otherCatalog: FactoryDefinitionCatalog = {
      ...catalog,
      pipelines: [...catalog.pipelines, { id: otherPipelineId, workspaceId, aliases: ["Custom"] }],
      deliveryPolicyRevisions: [
        ...catalog.deliveryPolicyRevisions,
        { id: otherDeliveryPolicyId, workspaceId, pipelineId: otherPipelineId },
      ],
    };
    const otherPipelineDef = compileFactoryDefinition(
      {
        kind: "structured",
        value: {
          schemaVersion: 1,
          kind: "serial",
          pipeline: otherPipelineId,
          repository: repositoryId,
          sandboxProvider: "vercel",
          agent: compiledFixture.bundle.agent,
          executionPolicy: executionPolicyId,
          deliveryPolicy: otherDeliveryPolicyId,
          operatingRulesMd: "Custom pipeline.",
          stages: [
            {
              id: stageId,
              slug: "plan",
              name: "Plan",
              description: "Plan work",
              promptTemplateMd: "Plan {{session.prompt}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
          ],
        },
      },
      otherCatalog,
    );
    if (!otherPipelineDef.ok) throw new Error("Other pipeline fixture failed to compile.");

    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        extraHandler: ({ url }) => {
          if (url.pathname.endsWith("/factory_definition_revisions")) {
            return Response.json([
              {
                id: revisionId,
                definition_json: otherPipelineDef.definitionJson,
                canonical_digest: otherPipelineDef.canonicalDigest,
                created_at: now,
              },
            ]);
          }
          if (url.pathname.endsWith("/delivery_policies")) {
            const filter = url.searchParams.get("pipeline_id");
            if (filter === `eq.${otherPipelineId}`) {
              return Response.json([{ current_revision_id: otherDeliveryPolicyId, revision: 4 }]);
            }
            return Response.json([{ current_revision_id: deliveryPolicyId, revision: 1 }]);
          }
          if (url.pathname.endsWith("/delivery_policy_revisions")) {
            return Response.json([
              {
                id: otherDeliveryPolicyId,
                workspace_id: workspaceId,
                pipeline_id: otherPipelineId,
                revision: 4,
                created_at: now,
                requirements: {
                  version: 1,
                  deliveryMode: "code",
                  requiredChecks: [],
                  minimumApprovals: 0,
                  requireCodeOwnerReview: false,
                  requireResolvedThreads: true,
                  requiredEvidence: [],
                  freshnessSeconds: 3600,
                  requireArtifactApprovalForDelivery: false,
                },
              },
            ]);
          }
          return null;
        },
      }),
    );

    const state = await loadSettingsFactoryDefinitionState(admin, workspaceId);
    expect(state.activeDefinition?.pipelineId).toBe(otherPipelineId);
    expect(state.liveDeliveryPolicyRevision).toBe(4);
  });

  it("rejects stale expectedActivationNumber or expectedDraftId with 409 conflict", async () => {
    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 2,
        draft: {
          id: draftId,
          definition_json: compiledActive.definitionJson,
          canonical_digest: compiledActive.canonicalDigest,
        },
      }),
    );

    const staleActivation = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 1,
        expectedDraftId: null,
        patch: { kind: "sandbox-provider", sandboxProvider: "e2b" },
      },
    });
    expect(staleActivation).toEqual({
      ok: false,
      status: 409,
      error: "The active factory definition changed. Reload before retrying.",
    });

    const staleDraft = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 2,
        expectedDraftId: null,
        patch: { kind: "sandbox-provider", sandboxProvider: "e2b" },
      },
    });
    expect(staleDraft).toEqual({
      ok: false,
      status: 409,
      error: "Another configuration draft was saved. Reload before retrying.",
    });
    expect(mocks.mutateFactoryDefinition).not.toHaveBeenCalled();
  });

  it("allocates archived stage anchor rows inside the atomic draft RPC only after compilation succeeds", async () => {
    let rpcCalled = false;
    let rpcBody: unknown = null;
    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        extraHandler: ({ method, url, body }) => {
          if (url.pathname.endsWith("/pipeline_stages") && method === "GET") {
            return Response.json([{ id: stageId, slug: "plan", position: 1 }]);
          }
          if (url.pathname.endsWith("/rpc/save_settings_factory_definition_draft")) {
            rpcCalled = true;
            rpcBody = body;
            return Response.json({
              id: draftId,
              base_activation_number: 1,
              schema_version: 1,
              definition_json: compiledActive.definitionJson,
              canonical_digest: compiledActive.canonicalDigest,
              created_at: now,
            });
          }
          return null;
        },
      }),
    );

    // Invalid forward stage reference should fail compilation WITHOUT calling the draft RPC
    const invalidRes = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 1,
        expectedDraftId: null,
        patch: {
          kind: "pipeline",
          name: "Default",
          operatingRulesMd: "",
          stages: [
            {
              id: stageId,
              slug: "plan",
              name: "Plan",
              description: "",
              promptTemplateMd: "Use {{artifact.previousStages.build}}",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
            {
              id: null,
              slug: "build",
              name: "Build",
              description: "",
              promptTemplateMd: "Build it.",
              anyoneCanApprove: true,
              approverMemberIds: [],
            },
          ],
        },
      },
    });
    expect(invalidRes).toMatchObject({ ok: false, status: 422 });
    expect(rpcCalled).toBe(false);

    const validRes = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 1,
        expectedDraftId: null,
        patch: {
          kind: "pipeline",
          name: "Default",
          operatingRulesMd: "Updated rules.",
          stages: [
            {
              id: stageId,
              slug: "plan",
              name: "Plan",
              description: "",
              promptTemplateMd: "Plan {{session.prompt}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
            {
              id: null,
              slug: "build",
              name: "Build",
              description: "",
              promptTemplateMd: "Build {{artifact.previousStages.plan}}.",
              anyoneCanApprove: true,
              approverMemberIds: [],
            },
          ],
        },
      },
    });
    expect(validRes.ok).toBe(true);
    expect(rpcCalled).toBe(true);
    expect(rpcBody).toMatchObject({
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_actor_user_id: actorUserId,
      p_expected_activation_number: 1,
      p_new_pipeline_stages: [
        expect.objectContaining({
          slug: "build",
          name: "Build",
          promptTemplateMd: "Build {{artifact.previousStages.plan}}.",
          anyoneCanApprove: true,
        }),
      ],
    });
    const compiledPayload = JSON.parse(
      (rpcBody as { p_definition_json: string }).p_definition_json,
    );
    expect(compiledPayload.operatingRulesMd).toBe("Updated rules.");
    expect(compiledPayload.stages.map((s: { slug: string }) => s.slug)).toEqual(["plan", "build"]);
  });

  it("propagates atomic 409 conflict when save_settings_factory_definition_draft detects a racing draft", async () => {
    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        extraHandler: ({ url }) => {
          if (url.pathname.endsWith("/rpc/save_settings_factory_definition_draft")) {
            return Response.json(
              {
                code: "PT409",
                message: "Another configuration draft was saved. Reload before retrying.",
              },
              { status: 409 },
            );
          }
          return null;
        },
      }),
    );

    const conflict = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 1,
        expectedDraftId: null,
        patch: { kind: "sandbox-provider", sandboxProvider: "e2b" },
      },
    });
    expect(conflict).toEqual({
      ok: false,
      status: 409,
      error: "Another configuration draft was saved. Reload before retrying.",
    });
  });

  it("persists candidate execution and delivery policy revisions atomically without calling live pointer RPCs", async () => {
    let legacyPolicyRpcCalled = false;
    let draftRpcBody: Record<string, unknown> | null = null;
    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        extraHandler: ({ url, body }) => {
          if (
            url.pathname.endsWith("/rpc/save_execution_policy") ||
            url.pathname.endsWith("/rpc/save_delivery_policy")
          ) {
            legacyPolicyRpcCalled = true;
          }
          if (url.pathname.endsWith("/rpc/save_settings_factory_definition_draft")) {
            draftRpcBody = body as Record<string, unknown>;
            return Response.json({
              id: draftId,
              base_activation_number: 1,
              schema_version: 1,
              definition_json: compiledActive.definitionJson,
              canonical_digest: compiledActive.canonicalDigest,
              created_at: now,
            });
          }
          return null;
        },
      }),
    );

    const execResult = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 1,
        expectedDraftId: null,
        patch: {
          kind: "execution-policy",
          expectedPolicyRevision: 1,
          requirements: {
            version: 1,
            maxRepairAttempts: 5,
            maxExecutionMs: 1_800_000,
            maxTotalTokens: null,
            maxCostUsd: null,
          },
        },
      },
    });

    expect(execResult.ok).toBe(true);
    expect(legacyPolicyRpcCalled).toBe(false);
    expect(draftRpcBody).toMatchObject({
      p_execution_policy_revision_id: expect.any(String),
      p_expected_live_execution_policy_revision: 1,
      p_execution_policy_requirements: {
        version: 1,
        maxRepairAttempts: 5,
        maxExecutionMs: 1_800_000,
        maxTotalTokens: null,
        maxCostUsd: null,
      },
    });

    const delivResult = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 1,
        expectedDraftId: null,
        patch: {
          kind: "delivery-policy",
          pipelineId,
          expectedPolicyRevision: 1,
          requirements: {
            version: 1,
            deliveryMode: "analysis",
            requiredChecks: [],
            minimumApprovals: 0,
            requireCodeOwnerReview: false,
            requireResolvedThreads: false,
            requiredEvidence: [],
            freshnessSeconds: 3600,
            requireArtifactApprovalForDelivery: false,
          },
        },
      },
    });

    expect(delivResult.ok).toBe(true);
    expect(legacyPolicyRpcCalled).toBe(false);
    expect(draftRpcBody).toMatchObject({
      p_delivery_policy_revision_id: expect.any(String),
      p_delivery_policy_pipeline_id: pipelineId,
      p_expected_live_delivery_policy_revision: 1,
      p_delivery_policy_requirements: {
        version: 1,
        deliveryMode: "analysis",
      },
    });
  });

  it("preserves definition-owned stage contents in archivedStages when removing an edited stage", async () => {
    const secondStageId = "54500000-0001-4000-8000-000000000022";
    const otherMemberId = "54500000-0001-4000-8000-000000000023";
    mocks.loadCatalog.mockResolvedValue({
      ...catalog,
      approvers: [
        { id: memberId, workspaceId },
        { id: otherMemberId, workspaceId },
      ],
    });

    const editedTwoStageDef = compileFactoryDefinition(
      {
        kind: "structured",
        value: {
          schemaVersion: 1,
          kind: "serial",
          pipeline: pipelineId,
          repository: repositoryId,
          sandboxProvider: "vercel",
          agent: compiledFixture.bundle.agent,
          executionPolicy: executionPolicyId,
          deliveryPolicy: deliveryPolicyId,
          operatingRulesMd: "Published rules.",
          stages: [
            {
              id: stageId,
              slug: "plan",
              name: "Plan",
              description: "Plan work",
              promptTemplateMd: "Plan {{session.prompt}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
            {
              id: secondStageId,
              slug: "verify",
              name: "Verify (Definition Edited)",
              description: "Definition description",
              promptTemplateMd: "Definition-edited prompt {{artifact.previousStages.plan}}.",
              anyoneCanApprove: false,
              approverMemberIds: [otherMemberId],
            },
          ],
        },
      },
      {
        ...catalog,
        approvers: [
          { id: memberId, workspaceId },
          { id: otherMemberId, workspaceId },
        ],
      },
    );
    if (!editedTwoStageDef.ok) throw new Error("Two-stage fixture failed to compile.");

    const removedSecondStageDef = compileFactoryDefinition(
      {
        kind: "structured",
        value: {
          schemaVersion: 1,
          kind: "serial",
          pipeline: pipelineId,
          repository: repositoryId,
          sandboxProvider: "vercel",
          agent: compiledFixture.bundle.agent,
          executionPolicy: executionPolicyId,
          deliveryPolicy: deliveryPolicyId,
          operatingRulesMd: "Published rules.",
          stages: [
            {
              id: stageId,
              slug: "plan",
              name: "Plan",
              description: "Plan work",
              promptTemplateMd: "Plan {{session.prompt}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
          ],
        },
      },
      catalog,
    );
    if (!removedSecondStageDef.ok) throw new Error("Single-stage fixture failed to compile.");

    // Live pipeline_stages row still holds stale DB contents for secondStageId
    const stalePipeline = {
      ...defaultPipelineConfig,
      stages: [
        ...defaultPipelineConfig.stages,
        {
          id: secondStageId,
          pipelineId,
          position: 2,
          slug: "verify",
          name: "Verify (Stale DB Row)",
          description: "Stale DB description",
          promptTemplateMd: "Stale DB prompt",
          anyoneCanApprove: true,
          approverMemberIds: [],
        },
      ],
    };
    mocks.loadDefaultPipeline.mockResolvedValue(stalePipeline);
    mocks.loadPipelineByDefinition.mockResolvedValue(stalePipeline);

    let saved = false;
    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        extraHandler: ({ method, url }) => {
          if (url.pathname.endsWith("/pipeline_stages") && method === "GET") {
            return Response.json([
              { id: stageId, slug: "plan", position: 1 },
              { id: secondStageId, slug: "verify", position: 2 },
            ]);
          }
          if (url.pathname.endsWith("/factory_definition_drafts")) {
            const rows = saved
              ? [
                  {
                    id: draftId,
                    base_activation_number: 1,
                    schema_version: 1,
                    definition_json: removedSecondStageDef.definitionJson,
                    canonical_digest: removedSecondStageDef.canonicalDigest,
                    created_at: "2026-11-15T20:05:00.000Z",
                  },
                  {
                    id: "54500000-0001-4000-8000-000000000033",
                    base_activation_number: 1,
                    schema_version: 1,
                    definition_json: editedTwoStageDef.definitionJson,
                    canonical_digest: editedTwoStageDef.canonicalDigest,
                    created_at: "2026-11-15T20:01:00.000Z",
                  },
                ]
              : [
                  {
                    id: "54500000-0001-4000-8000-000000000033",
                    base_activation_number: 1,
                    schema_version: 1,
                    definition_json: editedTwoStageDef.definitionJson,
                    canonical_digest: editedTwoStageDef.canonicalDigest,
                    created_at: "2026-11-15T20:01:00.000Z",
                  },
                ];
            return Response.json(url.searchParams.get("limit") === "1" ? rows.slice(0, 1) : rows);
          }
          if (url.pathname.endsWith("/rpc/save_settings_factory_definition_draft")) {
            saved = true;
            return Response.json({
              id: draftId,
              base_activation_number: 1,
              schema_version: 1,
              definition_json: removedSecondStageDef.definitionJson,
              canonical_digest: removedSecondStageDef.canonicalDigest,
              created_at: "2026-11-15T20:05:00.000Z",
            });
          }
          return null;
        },
      }),
    );

    const res = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 1,
        expectedDraftId: "54500000-0001-4000-8000-000000000033",
        patch: {
          kind: "pipeline",
          name: "Default",
          operatingRulesMd: "Published rules.",
          stages: [
            {
              id: stageId,
              slug: "plan",
              name: "Plan",
              description: "Plan work",
              promptTemplateMd: "Plan {{session.prompt}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
          ],
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.pipeline?.archivedStages).toEqual([
      expect.objectContaining({
        id: secondStageId,
        name: "Verify (Definition Edited)",
        description: "Definition description",
        promptTemplateMd: "Definition-edited prompt {{artifact.previousStages.plan}}.",
        anyoneCanApprove: false,
        approverMemberIds: [otherMemberId],
      }),
    ]);
  });

  it("allows removing one stage after swapping two stages' slugs in a saved definition", async () => {
    const secondStageId = "54500000-0001-4000-8000-000000000022";
    const swappedDef = compileFactoryDefinition(
      {
        kind: "structured",
        value: {
          schemaVersion: 1,
          kind: "serial",
          pipeline: pipelineId,
          repository: repositoryId,
          sandboxProvider: "vercel",
          agent: compiledFixture.bundle.agent,
          executionPolicy: executionPolicyId,
          deliveryPolicy: deliveryPolicyId,
          operatingRulesMd: "Published rules.",
          stages: [
            {
              id: stageId,
              slug: "build",
              name: "Build",
              description: "",
              promptTemplateMd: "Build {{session.prompt}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
            {
              id: secondStageId,
              slug: "plan",
              name: "Plan",
              description: "",
              promptTemplateMd: "Plan {{artifact.previousStages.build}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
          ],
        },
      },
      catalog,
    );
    if (!swappedDef.ok) throw new Error("Swapped fixture failed to compile.");

    // Backing pipeline_stages rows still hold pre-swap slugs: stageId="plan", secondStageId="build"
    let rpcCalled = false;
    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        draft: {
          id: draftId,
          definition_json: swappedDef.definitionJson,
          canonical_digest: swappedDef.canonicalDigest,
        },
        extraHandler: ({ method, url }) => {
          if (url.pathname.endsWith("/pipeline_stages") && method === "GET") {
            return Response.json([
              { id: stageId, slug: "plan", position: 1 },
              { id: secondStageId, slug: "build", position: 2 },
            ]);
          }
          if (url.pathname.endsWith("/rpc/save_settings_factory_definition_draft")) {
            rpcCalled = true;
            return Response.json({
              id: draftId,
              base_activation_number: 1,
              schema_version: 1,
              definition_json: swappedDef.definitionJson,
              canonical_digest: swappedDef.canonicalDigest,
              created_at: now,
            });
          }
          return null;
        },
      }),
    );

    // Removing stageId (currently "build" in definition) while keeping secondStageId ("plan" in definition) must succeed
    const res = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "draft",
        expectedActivationNumber: 1,
        expectedDraftId: draftId,
        patch: {
          kind: "pipeline",
          name: "Default",
          operatingRulesMd: "Published rules.",
          stages: [
            {
              id: secondStageId,
              slug: "plan",
              name: "Plan",
              description: "",
              promptTemplateMd: "Plan {{session.prompt}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
          ],
        },
      },
    });

    expect(res.ok).toBe(true);
    expect(rpcCalled).toBe(true);
  });

  it("loads the backing pipeline for the definition's pipeline when publishing", async () => {
    const otherPipelineId = "54500000-0001-4000-8000-000000000044";
    const otherDeliveryPolicyId = "54500000-0001-4000-8000-000000000045";
    const otherCatalog: FactoryDefinitionCatalog = {
      ...catalog,
      pipelines: [...catalog.pipelines, { id: otherPipelineId, workspaceId, aliases: ["Custom"] }],
      deliveryPolicyRevisions: [
        ...catalog.deliveryPolicyRevisions,
        { id: otherDeliveryPolicyId, workspaceId, pipelineId: otherPipelineId },
      ],
    };
    const otherDef = compileFactoryDefinition(
      {
        kind: "structured",
        value: {
          schemaVersion: 1,
          kind: "serial",
          pipeline: otherPipelineId,
          repository: repositoryId,
          sandboxProvider: "vercel",
          agent: compiledFixture.bundle.agent,
          executionPolicy: executionPolicyId,
          deliveryPolicy: otherDeliveryPolicyId,
          operatingRulesMd: "Custom pipeline rules.",
          stages: [
            {
              id: stageId,
              slug: "plan",
              name: "Plan",
              description: "",
              promptTemplateMd: "Plan {{session.prompt}}.",
              anyoneCanApprove: false,
              approverMemberIds: [memberId],
            },
          ],
        },
      },
      otherCatalog,
    );
    if (!otherDef.ok) throw new Error("Other pipeline fixture failed to compile.");

    mocks.loadCatalog.mockResolvedValue(otherCatalog);
    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        draft: {
          id: draftId,
          definition_json: otherDef.definitionJson,
          canonical_digest: otherDef.canonicalDigest,
        },
        extraHandler: ({ url }) => {
          if (url.pathname.endsWith("/factory_definition_revisions")) {
            return Response.json([
              {
                id: revisionId,
                definition_json: otherDef.definitionJson,
                canonical_digest: otherDef.canonicalDigest,
                created_at: now,
              },
            ]);
          }
          if (url.pathname.endsWith("/delivery_policies")) {
            const filter = url.searchParams.get("pipeline_id");
            return Response.json([
              {
                current_revision_id:
                  filter === `eq.${otherPipelineId}` ? otherDeliveryPolicyId : deliveryPolicyId,
                revision: filter === `eq.${otherPipelineId}` ? 4 : 1,
              },
            ]);
          }
          if (url.pathname.endsWith("/delivery_policy_revisions")) {
            return Response.json([
              {
                id: otherDeliveryPolicyId,
                workspace_id: workspaceId,
                pipeline_id: otherPipelineId,
                revision: 4,
                created_at: now,
                requirements: {
                  version: 1,
                  deliveryMode: "code",
                  requiredChecks: [],
                  minimumApprovals: 0,
                  requireCodeOwnerReview: false,
                  requireResolvedThreads: true,
                  requiredEvidence: [],
                  freshnessSeconds: 3600,
                  requireArtifactApprovalForDelivery: false,
                },
              },
            ]);
          }
          if (url.pathname.endsWith("/rpc/publish_settings_factory_definition_draft")) {
            return Response.json({
              id: "activation-2",
              revision_id: "54500000-0001-4000-8000-000000000055",
              activation_number: 2,
              previous_activation_number: 1,
              created_at: now,
            });
          }
          return null;
        },
      }),
    );

    const published = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: { action: "publish", expectedActivationNumber: 1, draftId },
    });

    expect(published.ok).toBe(true);
    expect(mocks.loadPipelineByDefinition).toHaveBeenCalledWith(admin, otherPipelineId);
    expect(mocks.loadDefaultPipeline).not.toHaveBeenCalled();
  });

  it("publishes the exact expected draft atomically and rejects stale publish attempts", async () => {
    let publishBody: unknown = null;
    const { admin } = makeClient(
      defaultStateResponder({
        activationNumber: 1,
        draft: {
          id: draftId,
          definition_json: compiledActive.definitionJson,
          canonical_digest: compiledActive.canonicalDigest,
        },
        extraHandler: ({ url, body }) => {
          if (url.pathname.endsWith("/rpc/publish_settings_factory_definition_draft")) {
            publishBody = body;
            return Response.json({
              id: "activation-2",
              revision_id: revisionId,
              activation_number: 2,
              previous_activation_number: 1,
              created_at: now,
            });
          }
          return null;
        },
      }),
    );

    const wrongDraft = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "publish",
        expectedActivationNumber: 1,
        draftId: "54500000-0001-4000-8000-000000000088",
      },
    });
    expect(wrongDraft).toEqual({
      ok: false,
      status: 409,
      error: "A newer configuration draft or activation exists. Reload before publishing.",
    });

    const published = await mutateSettingsFactoryDefinition({
      admin,
      workspaceId,
      actorUserId,
      command: {
        action: "publish",
        expectedActivationNumber: 1,
        draftId,
      },
    });
    expect(published.ok).toBe(true);
    expect(publishBody).toEqual({
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_actor_user_id: actorUserId,
      p_expected_activation_number: 1,
      p_draft_id: draftId,
      p_enabled_sandbox_providers: ["vercel", "e2b"],
      p_required_probes: ["git"],
    });
  });
});
