import { describe, expect, it } from "vitest";

import type { SettingsSetupData } from "@/features/settings/data";
import type { CompiledFactoryDefinition } from "@/lib/factory-definitions/compiler";
import { createEmptySettingsFactoryDefinitionState } from "@/lib/factory-definitions/settings-contracts";
import { buildSerialDefinitionFromCompiled } from "@/lib/factory-definitions/settings";
import {
  mapCompilerDiagnosticsToAgentFieldErrors,
  pipelineFromFactoryDefinition,
  projectSettingsDataWithFactoryDefinition,
} from "@/lib/factory-definitions/settings-projection";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const pipelineId = "00000000-0000-4000-8000-000000000002";
const repositoryId = "00000000-0000-4000-8000-000000000003";
const stage1Id = "00000000-0000-4000-8000-000000000011";
const stage2Id = "00000000-0000-4000-8000-000000000012";
const archivedStageId = "00000000-0000-4000-8000-000000000013";

const compiled: CompiledFactoryDefinition = {
  schemaVersion: 1,
  kind: "serial",
  pipelineId,
  repositoryId,
  sandboxProvider: "e2b",
  agent: {
    provider: "claude-code",
    model: "claude-opus-4-8[1m]",
    effort: "high",
    concurrencyLimit: 2,
    stallTimeoutMs: 600_000,
    maxRetries: 4,
    maxTurns: 12,
  },
  executionPolicyRevisionId: "00000000-0000-4000-8000-000000000021",
  deliveryPolicyRevisionId: "00000000-0000-4000-8000-000000000022",
  skillIds: [],
  toolIds: [],
  operatingRulesMd: "Follow compiled rules.",
  operatingRuleStageIds: [],
  stages: [
    {
      id: stage2Id,
      slug: "build",
      name: "Build",
      description: "Implement",
      promptTemplateMd: "Build {{session.prompt}}",
      anyoneCanApprove: true,
      approverMemberIds: [],
      previousStageIds: [],
    },
    {
      id: stage1Id,
      slug: "verify",
      name: "Verify",
      description: "Check",
      promptTemplateMd: "Check {{artifact.previousStages.build}}",
      anyoneCanApprove: false,
      approverMemberIds: ["00000000-0000-4000-8000-000000000031"],
      previousStageIds: [stage2Id],
    },
  ],
};

describe("factory definition settings projection", () => {
  it("projects compiled definition stages, agent config, and sandbox provider onto Settings data", () => {
    const base = {
      agentConfig: {
        agent_provider: "codex",
        agent_model: "gpt-5.6-sol",
      },
      factoryDefinition: createEmptySettingsFactoryDefinitionState(),
      pipeline: {
        id: pipelineId,
        isDefault: true,
        name: "Default",
        operatingRulesMd: "Old rules",
        stages: [
          {
            id: stage1Id,
            pipelineId,
            position: 1,
            slug: "plan",
            name: "Plan",
            description: "Old",
            promptTemplateMd: "Old",
            anyoneCanApprove: false,
            approverMemberIds: [],
          },
          {
            id: archivedStageId,
            pipelineId,
            position: 2,
            slug: "old-stage",
            name: "Old stage",
            description: "",
            promptTemplateMd: "Old",
            anyoneCanApprove: false,
            approverMemberIds: [],
          },
        ],
        archivedStages: [],
      },
      sandboxSettings: {
        activeProvider: "vercel",
        connections: {
          daytona: null,
          e2b: {
            apiKeyPreview: "e2b_...1234",
            connectionRevision: "rev-e2b",
            lastValidatedAt: "2026-11-15T00:00:00Z",
            lastValidationError: null,
            status: "connected",
            updatedAt: "2026-11-15T00:00:00Z",
            workspaceId,
          },
          vercel: null,
        },
        enabledProviders: ["vercel", "e2b", "daytona"],
        revision: 1,
        updatedAt: null,
      },
      setupHealth: {
        agentConfig: { configured: true, configuredKeys: [], status: "present", values: {} },
        defaultPipeline: { configured: true, pipelineId, stageCount: 2, status: "ready" },
        sandboxConnection: {
          connected: false,
          connectionRevision: null,
          displayName: null,
          lastValidationError: null,
          provider: "vercel",
          providerLabel: "Vercel Sandbox",
          status: "missing",
          updatedAt: null,
        },
      },
    } as unknown as SettingsSetupData;

    const state = {
      ...createEmptySettingsFactoryDefinitionState(),
      factoryId: "00000000-0000-4000-8000-000000000099",
      expectedActivationNumber: 2,
      activeDefinition: compiled,
    };

    const projected = projectSettingsDataWithFactoryDefinition(base, state);

    expect(projected.pipeline?.name).toBe("Default");
    expect(projected.pipeline?.operatingRulesMd).toBe("Follow compiled rules.");
    expect(
      projected.pipeline?.stages.map((stage) => [stage.id, stage.position, stage.slug]),
    ).toEqual([
      [stage2Id, 1, "build"],
      [stage1Id, 2, "verify"],
    ]);
    expect(projected.pipeline?.archivedStages?.map((stage) => stage.id)).toEqual([archivedStageId]);
    expect(projected.agentConfig).toEqual({
      agent_provider: "claude-code",
      agent_model: "claude-opus-4-8[1m]",
      agent_effort: "high",
      concurrency_limit: 2,
      stall_timeout_ms: 600_000,
      max_retries: 4,
      max_turns: 12,
    });
    expect(projected.sandboxSettings.activeProvider).toBe("e2b");
    expect(projected.setupHealth.sandboxConnection?.provider).toBe("e2b");
    expect(projected.setupHealth.sandboxConnection?.connected).toBe(true);
  });

  it("round-trips a compiled definition back into serial compiler input", () => {
    const serial = buildSerialDefinitionFromCompiled(compiled);
    expect(serial).toEqual({
      schemaVersion: 1,
      kind: "serial",
      pipeline: pipelineId,
      repository: repositoryId,
      sandboxProvider: "e2b",
      agent: compiled.agent,
      executionPolicy: compiled.executionPolicyRevisionId,
      deliveryPolicy: compiled.deliveryPolicyRevisionId,
      skills: [],
      tools: [],
      operatingRulesMd: "Follow compiled rules.",
      stages: [
        {
          id: stage2Id,
          slug: "build",
          name: "Build",
          description: "Implement",
          promptTemplateMd: "Build {{session.prompt}}",
          anyoneCanApprove: true,
          approverMemberIds: [],
        },
        {
          id: stage1Id,
          slug: "verify",
          name: "Verify",
          description: "Check",
          promptTemplateMd: "Check {{artifact.previousStages.build}}",
          anyoneCanApprove: false,
          approverMemberIds: ["00000000-0000-4000-8000-000000000031"],
        },
      ],
    });
  });

  it("maps compiler agent diagnostics to AgentConfigFieldErrors", () => {
    expect(
      mapCompilerDiagnosticsToAgentFieldErrors([
        {
          path: ["agent", "model"],
          code: "unsupported_capability",
          message: 'Choose a model supported by "codex".',
        },
        {
          path: ["agent", "effort"],
          code: "unsupported_capability",
          message: 'Remove effort for "cursor".',
        },
        {
          path: ["stages", 0, "promptTemplateMd"],
          code: "unreachable_stage",
          message: "Stage reference unavailable.",
        },
      ]),
    ).toEqual({
      agent_model: 'Choose a model supported by "codex".',
      agent_effort: 'Remove effort for "cursor".',
    });
  });

  it("preserves last definition-owned contents when projecting archived stages", () => {
    const staleLivePipeline = {
      id: pipelineId,
      isDefault: true,
      name: "Default",
      operatingRulesMd: "Old rules",
      stages: [
        {
          id: stage2Id,
          pipelineId,
          position: 1,
          slug: "build",
          name: "Build",
          description: "Implement",
          promptTemplateMd: "Build {{session.prompt}}",
          anyoneCanApprove: true,
          approverMemberIds: [],
        },
        {
          id: stage1Id,
          pipelineId,
          position: 2,
          slug: "verify",
          name: "Verify (Stale DB)",
          description: "Stale DB description",
          promptTemplateMd: "Stale DB prompt",
          anyoneCanApprove: true,
          approverMemberIds: [],
        },
      ],
      archivedStages: [],
    };
    const withoutVerify: CompiledFactoryDefinition = {
      ...compiled,
      stages: [compiled.stages[0]!],
    };

    const projected = pipelineFromFactoryDefinition(staleLivePipeline, withoutVerify, [compiled]);
    expect(projected.archivedStages).toEqual([
      expect.objectContaining({
        id: stage1Id,
        slug: "verify",
        name: "Verify",
        description: "Check",
        promptTemplateMd: "Check {{artifact.previousStages.build}}",
        anyoneCanApprove: false,
        approverMemberIds: ["00000000-0000-4000-8000-000000000031"],
      }),
    ]);
  });
});
