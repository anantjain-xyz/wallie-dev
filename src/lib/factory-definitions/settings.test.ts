import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionRequirements } from "@/lib/execution-policy/contracts";
import type { Database } from "@/lib/supabase/database.types";

import { compileFactoryDefinition } from "./compiler";
import type { FactoryDefinitionCatalog } from "./references";
import { loadFactorySettings, mutateFactorySettings } from "./settings";
import { factoryDefinitionFromBundle } from "./stored-definition";

const mocks = vi.hoisted(() => ({ loadCatalog: vi.fn(), activationRequirements: vi.fn() }));
vi.mock("./authority", () => ({
  loadFactoryDefinitionCatalog: mocks.loadCatalog,
  factoryActivationRequirements: mocks.activationRequirements,
}));

const id = (index: number) => "54200000-0005-4000-8000-" + String(index).padStart(12, "0");
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const pipelineId = id(4);
const repositoryId = id(5);
const stageId = id(6);
const revisionId = id(7);
const draftId = id(8);
const nextDraftId = id(9);
const nextRevisionId = id(10);
const stagedPolicyId = id(11);
const archivedStageId = id(12);
const requirements: ExecutionRequirements = {
  version: 1,
  maxRepairAttempts: 2,
  maxExecutionMs: 70_000,
  maxTotalTokens: null,
  maxCostUsd: null,
};
const catalog: FactoryDefinitionCatalog = {
  workspaceId,
  pipelines: [{ id: pipelineId, workspaceId }],
  repositories: [{ id: repositoryId, workspaceId }],
  executionPolicyRevisions: [],
  deliveryPolicyRevisions: [],
  skills: [],
  tools: [],
  approvers: [],
  sandboxProviders: ["vercel"],
};

const live = compileFactoryDefinition(
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
        effort: null,
        concurrencyLimit: 1,
        stallTimeoutMs: 60_000,
        maxRetries: 1,
        maxTurns: 5,
      },
      stages: [{ id: stageId, slug: "prepare", name: "Prepare", anyoneCanApprove: true }],
    },
  },
  catalog,
);
if (!live.ok) throw new Error("The published test fixture must compile.");
const staged = compileFactoryDefinition(
  {
    kind: "structured",
    value: {
      ...factoryDefinitionFromBundle(live.bundle),
      executionPolicy: stagedPolicyId,
      stages: [
        { ...factoryDefinitionFromBundle(live.bundle).stages[0], name: "Prepare candidate" },
      ],
    },
  },
  {
    ...catalog,
    executionPolicyRevisions: [{ id: stagedPolicyId, workspaceId }],
  },
);
if (!staged.ok) throw new Error("The staged policy test fixture must compile.");

function stored(definition: { definitionJson: string; canonicalDigest: string }, targetId: string) {
  return {
    id: targetId,
    definition_json: definition.definitionJson,
    canonical_digest: definition.canonicalDigest,
  };
}

type DraftFixture = ReturnType<typeof stored> & { settings_metadata: unknown };
const publishedFixture = { ...stored(live, revisionId), source_draft_id: null };
const existingDraft: DraftFixture = {
  ...stored(staged, draftId),
  settings_metadata: {
    executionPolicy: { id: stagedPolicyId, requirements },
    archivedStages: [
      {
        id: archivedStageId,
        pipelineId,
        position: 2,
        slug: "review",
        name: "Review candidate",
        anyoneCanApprove: true,
        archivedAt: "2026-11-15T20:00:00.000Z",
      },
    ],
  },
};

function testClient({
  draft,
  rpc,
}: {
  draft?: DraftFixture;
  rpc?: (name: string, body: unknown) => Response;
} = {}) {
  const fetch = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const rest = url.pathname.replace("/rest/v1/", "");
    if (rest.startsWith("rpc/") && rpc && typeof init?.body === "string") {
      return rpc(rest, JSON.parse(init.body));
    }

    expect(url.searchParams.get("workspace_id")).toBe("eq." + workspaceId);
    switch (rest) {
      case "factories":
        return Response.json([{ id: factoryId }]);
      case "factory_definition_activations":
        return Response.json([{ activation_number: 3, revision_id: revisionId }]);
      case "factory_definition_revisions":
        return Response.json(publishedFixture);
      case "factory_definition_drafts":
        expect(url.searchParams.get("base_activation_number")).toBe("eq.3");
        return Response.json(draft ? [draft] : []);
      case "pipelines":
        return Response.json([
          { id: pipelineId, is_default: true, name: "Pipeline", operating_rules_md: "" },
        ]);
      case "pipeline_stages":
        return Response.json([{ id: stageId, archived_at: null }]);
      default:
        throw new Error("Unexpected Settings request " + rest);
    }
  });
  const client = createClient<Database>("http://localhost:9999", "test-key", { global: { fetch } });
  return {
    client,
    fetchedPaths: () =>
      fetch.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : input).pathname,
      ),
  };
}

describe("factory Settings snapshots", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadCatalog.mockResolvedValue(catalog);
    mocks.activationRequirements.mockReturnValue({
      enabledSandboxProviders: ["vercel"],
      requiredProbes: ["git"],
    });
  });

  it("shows archived candidates and changed policies only in manager views", async () => {
    const { client, fetchedPaths } = testClient({ draft: existingDraft });
    await expect(loadFactorySettings(client, workspaceId, false)).resolves.toMatchObject({
      published: { id: revisionId },
      draft: null,
      publishedStages: [{ id: stageId, name: "Prepare", slug: "prepare" }],
      pipeline: { stages: [{ id: stageId, name: "Prepare" }], archivedStages: [] },
      executionPolicy: null,
    });
    expect(fetchedPaths()).not.toContain("/rest/v1/factory_definition_drafts");

    await expect(loadFactorySettings(client, workspaceId, true)).resolves.toMatchObject({
      published: { id: revisionId },
      draft: { id: draftId },
      publishedStages: [{ id: stageId, name: "Prepare", slug: "prepare" }],
      pipeline: {
        stages: [{ id: stageId, name: "Prepare candidate" }],
        archivedStages: [{ id: archivedStageId, name: "Review candidate" }],
      },
      executionPolicy: requirements,
    });
  });

  it("preserves a staged policy when another section changes and returns the accepted save", async () => {
    const { client, fetchedPaths } = testClient({
      draft: existingDraft,
      rpc: (name, body) => {
        expect(name).toBe("rpc/save_settings_factory_definition_draft");
        expect(body).toMatchObject({
          p_factory_id: factoryId,
          p_actor_user_id: actorUserId,
          p_expected_activation_number: 3,
          p_expected_draft_id: draftId,
          p_settings_metadata: { executionPolicy: { id: stagedPolicyId, requirements } },
        });
        return Response.json({ id: nextDraftId, canonical_digest: "a".repeat(64) });
      },
    });
    await expect(
      mutateFactorySettings({
        client,
        workspaceId,
        actorUserId,
        command: {
          action: "save",
          expectedActivationNumber: 3,
          expectedDraftId: draftId,
          patch: { kind: "agent", agent: { ...live.bundle.agent, maxRetries: 2 } },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      snapshot: {
        draft: { id: nextDraftId, digest: "a".repeat(64) },
        agent: { maxRetries: 2 },
        executionPolicy: requirements,
      },
    });
    expect(fetchedPaths().at(-1)).toBe("/rest/v1/rpc/save_settings_factory_definition_draft");
  });

  it("refuses a write when the displayed base draft has changed", async () => {
    const { client, fetchedPaths } = testClient({ draft: existingDraft });
    await expect(
      mutateFactorySettings({
        client,
        workspaceId,
        actorUserId,
        command: {
          action: "save",
          expectedActivationNumber: 3,
          expectedDraftId: null,
          patch: { kind: "execution-policy", requirements },
        },
      }),
    ).resolves.toMatchObject({ ok: false, status: 409 });
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
    expect(fetchedPaths().some((path) => path.includes("/rpc/"))).toBe(false);
  });

  it("publishes only the displayed draft and returns the accepted revision even for a pending policy", async () => {
    const { client } = testClient({
      draft: existingDraft,
      rpc: (name, body) => {
        expect(name).toBe("rpc/publish_settings_factory_definition_draft");
        expect(body).toMatchObject({
          p_draft_id: draftId,
          p_expected_activation_number: 3,
          p_required_probes: ["git"],
        });
        return Response.json({ activation_number: 4, revision_id: nextRevisionId });
      },
    });
    await expect(
      mutateFactorySettings({
        client,
        workspaceId,
        actorUserId,
        command: { action: "publish", expectedActivationNumber: 3, draftId },
      }),
    ).resolves.toMatchObject({
      ok: true,
      snapshot: {
        draft: null,
        published: { id: nextRevisionId, digest: staged.canonicalDigest },
        publishedStages: [{ id: stageId, name: "Prepare candidate" }],
        activationNumber: 4,
        executionPolicy: requirements,
      },
    });
  });
});
