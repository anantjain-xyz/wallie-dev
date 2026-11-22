import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { compileFactoryDefinition } from "./compiler";
import { mutateFactoryDefinition } from "./mutations";
import type { FactoryDefinitionCatalog } from "./references";
import { recompileStoredFactoryDefinition } from "./stored-definition";

const mocks = vi.hoisted(() => ({ loadCatalog: vi.fn(), activationRequirements: vi.fn() }));
vi.mock("./authority", () => ({
  loadFactoryDefinitionCatalog: mocks.loadCatalog,
  factoryActivationRequirements: mocks.activationRequirements,
}));

const workspaceId = "54200000-0001-4000-8000-000000000001";
const factoryId = "54200000-0001-4000-8000-000000000002";
const actorUserId = "54200000-0001-4000-8000-000000000003";
const pipelineId = "54200000-0001-4000-8000-000000000004";
const repositoryId = "54200000-0001-4000-8000-000000000005";
const stageId = "54200000-0001-4000-8000-000000000006";
const draftId = "54200000-0001-4000-8000-000000000007";
const revisionId = "54200000-0001-4000-8000-000000000008";
const memberId = "54200000-0001-4000-8000-000000000009";
const createdAt = "2026-11-15T20:00:00.000Z";

const catalog: FactoryDefinitionCatalog = {
  workspaceId,
  pipelines: [{ id: pipelineId, workspaceId, aliases: ["Current pipeline"] }],
  repositories: [{ id: repositoryId, workspaceId, aliases: ["wallie/factory"] }],
  executionPolicyRevisions: [],
  deliveryPolicyRevisions: [],
  skills: [],
  tools: [],
  approvers: [{ id: memberId, workspaceId }],
  sandboxProviders: ["vercel"],
};
const source = {
  kind: "structured",
  value: {
    schemaVersion: 1,
    kind: "serial",
    pipeline: "Current pipeline",
    repository: "wallie/factory",
    sandboxProvider: "vercel",
    agent: {
      provider: "codex",
      model: "gpt-5.6-sol",
      concurrencyLimit: 1,
      stallTimeoutMs: 60_000,
      maxRetries: 1,
      maxTurns: 5,
    },
    stages: [
      {
        id: stageId,
        slug: "prepare",
        name: "Préparer",
        promptTemplateMd: "Use {{session.prompt}}.",
        approverMemberIds: [memberId],
      },
    ],
  },
} as const;
const compiled = compileFactoryDefinition(source, catalog);
if (!compiled.ok) throw new Error("The factory definition test fixture did not compile.");

function fixture(
  handler: (request: { url: URL; body?: unknown }) => Response,
  selectedFactoryId?: string,
) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/factories")) {
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(url.searchParams.get("status")).toBe("eq.active");
      expect(url.searchParams.get("id")).toBe(selectedFactoryId ? `eq.${selectedFactoryId}` : null);
      expect(url.searchParams.get("is_default")).toBe(selectedFactoryId ? null : "eq.true");
      return Response.json([{ id: factoryId, is_default: selectedFactoryId === undefined }]);
    }
    return handler({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
  });
  const admin = createClient<Database>("http://localhost:9999", "test-service-role", {
    global: { fetch },
  });
  return { admin, fetch };
}

function assertStoredScope(url: URL, expectedId: string) {
  expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
  expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
  expect(url.searchParams.get("id")).toBe(`eq.${expectedId}`);
}

const stored = {
  definition_json: compiled.definitionJson,
  canonical_digest: compiled.canonicalDigest,
};

describe("factory definition commands", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadCatalog.mockResolvedValue(catalog);
    mocks.activationRequirements.mockReturnValue({
      enabledSandboxProviders: ["vercel"],
      requiredProbes: ["git", "codexExternalSandbox"],
    });
  });

  it.each([undefined, factoryId])(
    "saves compiler bytes and the workspace and actor scope for factory %s",
    async (selectedFactoryId) => {
      const { admin } = fixture(({ url, body }) => {
        if (url.pathname.endsWith("/factory_definition_drafts")) {
          expect(url.searchParams.get("base_activation_number")).toBe("is.null");
          return Response.json([]);
        }
        if (url.pathname.endsWith("/pipeline_stages")) return Response.json([{ id: stageId }]);
        expect(url.pathname).toMatch(/\/rpc\/save_settings_factory_definition_draft$/);
        expect(body).toEqual({
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_actor_user_id: actorUserId,
          p_expected_activation_number: 0,
          p_definition_json: stored.definition_json,
          p_canonical_digest: stored.canonical_digest,
          p_settings_metadata: { newStageIds: [] },
        });
        return Response.json({
          id: draftId,
          base_activation_number: null,
          schema_version: 1,
          canonical_digest: stored.canonical_digest,
          created_at: createdAt,
        });
      }, selectedFactoryId);
      await expect(
        mutateFactoryDefinition({
          admin,
          workspaceId,
          factoryId: selectedFactoryId,
          actorUserId,
          command: { action: "draft", expectedActivationNumber: 0, source },
        }),
      ).resolves.toEqual({
        ok: true,
        result: {
          draft: {
            id: draftId,
            baseActivationNumber: null,
            schemaVersion: 1,
            canonicalDigest: stored.canonical_digest,
            createdAt,
          },
        },
      });
    },
  );

  it("carries the exact published stage archive into the next declarative draft", async () => {
    const removedId = "54200000-0001-4000-8000-000000000010";
    const retainedArchiveId = "54200000-0001-4000-8000-000000000011";
    const policyId = "54200000-0001-4000-8000-000000000012";
    const policyCatalog = { ...catalog, executionPolicyRevisions: [{ id: policyId, workspaceId }] };
    mocks.loadCatalog.mockResolvedValue(policyCatalog);
    const originalStage = source.value.stages[0];
    const activated = compileFactoryDefinition(
      {
        kind: "structured",
        value: {
          ...source.value,
          executionPolicy: policyId,
          stages: [{ ...originalStage, id: removedId, slug: "review", name: "Review" }],
        },
      },
      policyCatalog,
    );
    if (!activated.ok) throw new Error("The activated factory fixture must compile.");
    const archived = {
      ...originalStage,
      pipelineId,
      archivedAt: "2000-01-01T00:00:00Z",
      position: 2,
      anyoneCanApprove: false,
      description: "",
    };
    const { admin } = fixture(({ url, body }) => {
      if (url.pathname.endsWith("/factory_definition_drafts")) return Response.json([]);
      if (url.pathname.endsWith("/factory_definition_activations")) {
        expect(url.searchParams.get("activation_number")).toBe("eq.3");
        expect(url.searchParams.get("workspace_id")).toBe("eq." + workspaceId);
        expect(url.searchParams.get("factory_id")).toBe("eq." + factoryId);
        return Response.json([
          {
            revision: {
              definition_json: activated.definitionJson,
              source: {
                settings_metadata: {
                  pipelineName: "Published name",
                  archivedStages: [archived, { ...archived, id: retainedArchiveId, slug: "align" }],
                  executionPolicy: {
                    id: policyId,
                    requirements: {
                      version: 1,
                      maxRepairAttempts: 2,
                      maxExecutionMs: 60_000,
                      maxTotalTokens: null,
                      maxCostUsd: null,
                    },
                  },
                },
              },
            },
          },
        ]);
      }
      if (url.pathname.endsWith("/pipeline_stages")) return Response.json([{ id: stageId }]);
      expect(url.pathname).toMatch(/\/rpc\/save_settings_factory_definition_draft$/);
      expect(body).toMatchObject({
        p_expected_activation_number: 3,
        p_settings_metadata: {
          archivedStages: [
            expect.objectContaining({ id: removedId, name: "Review", slug: "review" }),
            expect.objectContaining({ id: retainedArchiveId, slug: "align" }),
          ],
        },
      });
      expect(body).not.toHaveProperty("p_settings_metadata.executionPolicy");
      expect(body).not.toHaveProperty("p_settings_metadata.pipelineName");
      return Response.json({ id: draftId });
    });
    await expect(
      mutateFactoryDefinition({
        admin,
        workspaceId,
        actorUserId,
        command: {
          action: "draft",
          expectedActivationNumber: 3,
          expectedDraftId: null,
          source: { kind: "structured", value: { ...source.value, executionPolicy: policyId } },
        },
      }),
    ).resolves.toMatchObject({ ok: true, result: { draft: { id: draftId } } });
  });

  it("publishes only a scoped stored draft and passes server-derived capability requirements", async () => {
    const { admin } = fixture(({ url, body }) => {
      if (url.pathname.endsWith("/factory_definition_drafts")) {
        assertStoredScope(url, draftId);
        return Response.json([stored]);
      }
      expect(url.pathname).toMatch(/\/rpc\/publish_factory_definition_draft$/);
      expect(body).toEqual({
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
        p_actor_user_id: actorUserId,
        p_expected_activation_number: 5,
        p_draft_id: draftId,
        p_enabled_sandbox_providers: ["vercel"],
        p_required_probes: ["git", "codexExternalSandbox"],
      });
      return Response.json({
        id: "activation",
        revision_id: revisionId,
        activation_number: 6,
        previous_activation_number: 5,
        created_at: createdAt,
      });
    });
    await expect(
      mutateFactoryDefinition({
        admin,
        workspaceId,
        actorUserId,
        command: { action: "publish", expectedActivationNumber: 5, draftId },
      }),
    ).resolves.toEqual({
      ok: true,
      result: {
        activation: {
          id: "activation",
          revisionId,
          activationNumber: 6,
          previousActivationNumber: 5,
          createdAt,
        },
      },
    });
  });

  it.each([undefined, { taskClassId: stageId, candidateBps: 2_000 }])(
    "activates reviewed routing through the exact draft and expected head RPC (%j)",
    async (canary) => {
      const { admin } = fixture(({ url, body }) => {
        if (url.pathname.endsWith("/factory_definition_drafts")) {
          assertStoredScope(url, draftId);
          return Response.json([stored]);
        }
        expect(url.pathname.split("/").at(-1)).toBe(
          canary ? "activate_factory_routing_canary" : "activate_reviewed_factory_routing",
        );
        expect(body).toEqual({
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_actor_user_id: actorUserId,
          p_expected_activation_number: 5,
          p_draft_id: draftId,
          p_enabled_sandbox_providers: ["vercel"],
          p_required_probes: ["git", "codexExternalSandbox"],
          ...(canary
            ? { p_task_class_id: canary.taskClassId, p_candidate_bps: canary.candidateBps }
            : {}),
        });
        return Response.json({
          activationId: memberId,
          activationNumber: 6,
          previousActivationNumber: 5,
          revisionId,
          createdAt,
        });
      });
      await expect(
        mutateFactoryDefinition({
          admin,
          workspaceId,
          actorUserId,
          command: { action: "activate-routing", expectedActivationNumber: 5, draftId, canary },
        }),
      ).resolves.toEqual({
        ok: true,
        result: {
          activation: {
            id: memberId,
            revisionId,
            activationNumber: 6,
            previousActivationNumber: 5,
            createdAt,
          },
        },
      });
    },
  );

  it("rejects rollback when a stored approver is absent from the live catalog", async () => {
    mocks.loadCatalog.mockResolvedValue({ ...catalog, approvers: [] });
    const { admin, fetch } = fixture(({ url }) => {
      expect(url.pathname).toMatch(/\/factory_definition_revisions$/);
      assertStoredScope(url, revisionId);
      return Response.json([stored]);
    });
    await expect(
      mutateFactoryDefinition({
        admin,
        workspaceId,
        actorUserId,
        command: { action: "rollback", expectedActivationNumber: 2, revisionId },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      diagnostics: [{ path: ["stages", 0, "approverMemberIds", 0], code: "missing_reference" }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { action: "publish", expectedActivationNumber: 2, draftId },
    { action: "rollback", expectedActivationNumber: 2, revisionId },
  ] as const)(
    "blocks $action when a pinned scorer revision cannot be resolved",
    async (command) => {
      const scorerRevisionId = "54200000-0001-4000-8000-000000000013";
      const candidate = compileFactoryDefinition(
        {
          ...source,
          value: { ...source.value, schemaVersion: 2, scorerRevisionIds: [scorerRevisionId] },
        },
        {
          ...catalog,
          factoryId,
          scorerRevisions: [{ id: scorerRevisionId, workspaceId, factoryId }],
        },
      );
      if (!candidate.ok) throw new Error("Scored factory definition failed to compile.");
      const { admin, fetch } = fixture(({ url }) => {
        const publishing = command.action === "publish";
        expect(url.pathname).toMatch(
          publishing ? /\/factory_definition_drafts$/ : /\/factory_definition_revisions$/,
        );
        assertStoredScope(url, publishing ? draftId : revisionId);
        return Response.json([
          {
            definition_json: candidate.definitionJson,
            canonical_digest: candidate.canonicalDigest,
          },
        ]);
      });
      await expect(
        mutateFactoryDefinition({ admin, workspaceId, actorUserId, command }),
      ).resolves.toMatchObject({
        ok: false,
        status: 422,
        diagnostics: [{ path: ["scorerRevisionIds", 0], code: "missing_reference" }],
      });
      expect(mocks.loadCatalog).toHaveBeenCalledWith(
        admin,
        expect.objectContaining({
          workspaceId,
          factoryId,
          scorerRevisionIds: [scorerRevisionId],
        }),
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("reports a stale rollback head returned by the database command", async () => {
    const { admin } = fixture(({ url, body }) => {
      if (url.pathname.endsWith("/factory_definition_revisions")) return Response.json([stored]);
      expect(url.pathname).toMatch(/\/rpc\/rollback_factory_definition$/);
      expect(body).toMatchObject({ p_expected_activation_number: 2, p_revision_id: revisionId });
      return Response.json({ code: "PT409", message: "Reload before retrying." }, { status: 409 });
    });
    await expect(
      mutateFactoryDefinition({
        admin,
        workspaceId,
        actorUserId,
        command: { action: "rollback", expectedActivationNumber: 2, revisionId },
      }),
    ).resolves.toEqual({ ok: false, status: 409, error: "Reload before retrying." });
  });
});

describe("stored factory definition identity", () => {
  it("preserves the exact archived bytes when display aliases change", () => {
    expect(
      recompileStoredFactoryDefinition(stored.definition_json, stored.canonical_digest, {
        ...catalog,
        repositories: [{ id: repositoryId, workspaceId, aliases: ["renamed/factory"] }],
      }),
    ).toEqual(compiled);
  });

  it("rejects binding an absent stable ID to a different component via an alias", () => {
    const otherId = "54200000-0001-4000-8000-000000000010";
    expect(
      recompileStoredFactoryDefinition(stored.definition_json, stored.canonical_digest, {
        ...catalog,
        repositories: [{ id: otherId, workspaceId, aliases: [repositoryId] }],
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ path: [], code: "invalid_schema" }] });
  });
});
