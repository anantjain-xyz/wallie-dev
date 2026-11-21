import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { RoutingDraftEvidence } from "@/lib/model-routing/draft-contracts";
import type { Database } from "@/lib/supabase/database.types";

import { loadFactoryEditorDocument, loadFactoryEditorSnapshot } from "./editor";

const fixtureId = (n: number) => `56100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const workspace = fixtureId(1);
const defaultFactory = fixtureId(2);
const selectedFactory = fixtureId(3);
const selectedPipeline = fixtureId(4);
const selectedStage = fixtureId(5);
const selectedRepository = fixtureId(6);
const installation = fixtureId(7);
const agentId = fixtureId(8);
const promptRevision = fixtureId(9);
const requestedDraft = fixtureId(10);
const proposalDraft = fixtureId(12);
const createdAt = "2026-11-21T20:00:00Z";
const proposal = {
  version: 1,
  experimentId: fixtureId(13),
  candidateKey: "a".repeat(64),
  suite: { id: fixtureId(14), revisionId: fixtureId(15), purpose: "holdout", name: "Delivery" },
  scorerRevisionId: fixtureId(16),
  scorerName: "Delivery scorer",
  taskClassName: "Invoice delivery",
  definitionDigest: "c".repeat(64),
  replayPolicyRevisionId: fixtureId(17),
  replayPolicyDigest: "b".repeat(64),
  ruleId: fixtureId(18),
  capturedAt: createdAt,
  qualityPassRateBps: 9_000,
  resolvedTrials: 5,
  measuredMeanCostUsd: "0.08",
  constraints: {
    qualityFloorBps: 8_000,
    minResolvedTrials: 5,
    maxMeanCostUsd: null,
    maxLatencyMs: null,
    minConfidenceBps: null,
  },
  p95WallLatencyMs: null,
  isRecommended: true,
} satisfies RoutingDraftEvidence;
const directProposal = { ...proposal, candidateKey: "d".repeat(64) };

function fixture({
  pipeline = true,
  repository = true,
  factoryArchived = false,
  routingEvidence,
}: {
  pipeline?: boolean;
  repository?: boolean;
  factoryArchived?: boolean;
  routingEvidence?: "inherited" | "direct" | "none";
} = {}) {
  const calls: URL[] = [];
  const client = createClient<Database>("https://database.example.test", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        calls.push(url);
        const { searchParams } = url;
        expect(searchParams.get("workspace_id")).toBe(`eq.${workspace}`);
        const table = url.pathname.split("/").at(-1);
        switch (table) {
          case "factories":
            expect(searchParams.get("status")).toBe("eq.active");
            if (searchParams.get("is_default") === "eq.true") {
              return Response.json([{ id: defaultFactory, is_default: true }]);
            }
            return Response.json(
              !factoryArchived && searchParams.get("id") === `eq.${selectedFactory}`
                ? [{ id: selectedFactory, is_default: false }]
                : [],
            );
          case "factory_definition_activations":
            expect(searchParams.get("factory_id")).toBe(`eq.${selectedFactory}`);
            return Response.json([]);
          case "factory_definition_drafts":
            expect(searchParams.get("factory_id")).toBe(`eq.${selectedFactory}`);
            if (!routingEvidence) return Response.json([]);
            return Response.json([
              {
                id: requestedDraft,
                created_at: createdAt,
                canonical_digest: "e".repeat(64),
                routing_evidence_source_draft_id: routingEvidence === "none" ? null : proposalDraft,
                definition_json: JSON.stringify({
                  schemaVersion: 1,
                  kind: "serial",
                  pipelineId: selectedPipeline,
                  repositoryId: selectedRepository,
                  sandboxProvider: "vercel",
                  agent: {
                    provider: "codex",
                    model: "gpt-5.5",
                    effort: null,
                    concurrencyLimit: 1,
                    stallTimeoutMs: 900_000,
                    maxRetries: 3,
                    maxTurns: 5,
                  },
                  executionPolicyRevisionId: null,
                  deliveryPolicyRevisionId: null,
                  skillIds: [],
                  toolIds: [],
                  operatingRulesMd: "",
                  operatingRuleStageIds: [],
                  stages: [
                    {
                      id: selectedStage,
                      slug: "prepare",
                      name: "Prepare",
                      description: "",
                      promptTemplateMd: "Prepare the session.",
                      anyoneCanApprove: true,
                      approverMemberIds: [],
                      previousStageIds: [],
                    },
                  ],
                  modelRouting: {
                    version: 1,
                    taskClasses: [],
                    rules: [],
                    onUnmatched: { kind: "escalate" },
                  },
                }),
              },
            ]);
          case "factory_routing_draft_evidence":
            expect(searchParams.get("factory_id")).toBe(`eq.${selectedFactory}`);
            if (routingEvidence === "none") {
              expect(searchParams.get("draft_id")).toBe(`in.(${requestedDraft})`);
              return Response.json([]);
            }
            expect(searchParams.get("draft_id")).toBe(`in.(${requestedDraft},${proposalDraft})`);
            return Response.json([
              { draft_id: proposalDraft, evidence: proposal },
              ...(routingEvidence === "direct"
                ? [{ draft_id: requestedDraft, evidence: directProposal }]
                : []),
            ]);
          case "pipelines":
            expect(searchParams.get("factory_id")).toBe(`eq.${selectedFactory}`);
            expect(searchParams.get("pipeline_stages.archived_at")).toBe("is.null");
            expect(searchParams.get("pipeline_stages")).toBe("not.is.null");
            return Response.json(
              pipeline
                ? [
                    {
                      id: selectedPipeline,
                      name: "Factory Pipeline",
                      is_default: false,
                      operating_rules_md: "",
                    },
                  ]
                : [],
            );
          case "pipeline_stages":
            expect(searchParams.get("pipeline_id")).toBe(`eq.${selectedPipeline}`);
            return Response.json([
              {
                id: selectedStage,
                pipeline_id: selectedPipeline,
                name: "Prepare",
                slug: "prepare",
                position: 1,
                description: "",
                prompt_template_md: "",
                anyone_can_approve: true,
                approver_member_ids: [],
                archived_at: null,
              },
            ]);
          case "github_repositories":
            expect(searchParams.get("factory_id")).toBe(`eq.${selectedFactory}`);
            expect(searchParams.get("is_archived")).toBe("eq.false");
            return Response.json(
              repository
                ? [
                    {
                      id: selectedRepository,
                      full_name: "fixture/selected",
                      github_installation_id: installation,
                    },
                  ]
                : [],
            );
          case "github_installations":
            expect(searchParams.get("suspended")).toBe("eq.false");
            return Response.json([{ id: installation }]);
          case "factory_agent_prompt_revisions":
            expect(searchParams.get("factory_id")).toBe(`eq.${selectedFactory}`);
            return Response.json({
              id: promptRevision,
              agent_id: agentId,
              prompt_md: "",
              prompt_sha256: "a".repeat(64),
            });
          case "delivery_policies":
          case "execution_policies":
          case "workspace_agent_config":
          case "workspace_sandbox_settings":
          case "workspace_vercel_sandbox_connections":
          case "workspace_e2b_sandbox_connections":
          case "workspace_daytona_sandbox_connections":
            return Response.json([]);
          default:
            throw new Error(`Unexpected definition read ${url.pathname}`);
        }
      },
    },
  });
  return { calls, client };
}

describe("selected factory definition editor", () => {
  it("uses only the selected factory's active pipeline and connected repository to seed a draft", async () => {
    const { calls, client } = fixture();
    await expect(
      loadFactoryEditorSnapshot(client, workspace, selectedFactory),
    ).resolves.toMatchObject({
      activationNumber: 0,
      published: null,
      draft: null,
      baseline: {
        source: {
          pipeline: selectedPipeline,
          repository: selectedRepository,
          implementationAgent: promptRevision,
          stages: [{ id: selectedStage }],
        },
      },
    });
    expect(calls.some(({ pathname }) => pathname.endsWith("/workspace_onboarding"))).toBe(false);
  });

  it.each([{ pipeline: false }, { repository: false }])(
    "leaves the baseline empty when a prerequisite is missing %o",
    async (unavailable) => {
      const { client } = fixture(unavailable);
      await expect(
        loadFactoryEditorSnapshot(client, workspace, selectedFactory),
      ).resolves.toMatchObject({
        activationNumber: 0,
        baseline: null,
      });
    },
  );

  it.each([
    { id: fixtureId(11), factoryArchived: false },
    { id: selectedFactory, factoryArchived: true },
  ])(
    "does not fall back to the default factory when explicit selection $id is unavailable",
    async ({ id, factoryArchived }) => {
      const { calls, client } = fixture({ factoryArchived });
      await expect(loadFactoryEditorSnapshot(client, workspace, id)).resolves.toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.searchParams.get("is_default")).toBeNull();
    },
  );

  it("scopes a direct draft lookup to the selected factory", async () => {
    const { client } = fixture();
    await expect(
      loadFactoryEditorDocument(
        client,
        workspace,
        { kind: "draft", id: requestedDraft },
        selectedFactory,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["inherited", proposal],
    ["direct", directProposal],
    ["none", undefined],
  ] as const)("reads the %s proposal for a saved draft", async (routingEvidence, evidence) => {
    const { client } = fixture({ routingEvidence });
    const document = await loadFactoryEditorDocument(
      client,
      workspace,
      { kind: "draft", id: requestedDraft },
      selectedFactory,
    );
    expect(document?.id).toBe(requestedDraft);
    expect(document?.routingDraftEvidence).toEqual(evidence);
  });
});
