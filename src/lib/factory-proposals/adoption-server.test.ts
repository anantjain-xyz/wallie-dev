import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/workspaces/[workspaceId]/factories/[factoryId]/improvement-proposals/[proposalId]/revisions/[proposalRevisionId]/adoption/route";
import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { compileFactoryDefinition } from "@/lib/factory-definitions/compiler";
import type { FactoryDefinitionCatalog } from "@/lib/factory-definitions/references";
import { clearRateLimitsForTesting } from "@/lib/rate-limit";
import type { Database } from "@/lib/supabase/database.types";

import type {
  FactoryImprovementAdoption,
  FactoryImprovementAdoptionCommand,
  FactoryImprovementReviewProof,
} from "./adoption-contracts";
import {
  createFactoryImprovementReviewVerifier,
  ImprovementAdoptionGitHubError,
} from "./adoption-github";
import { adoptFactoryImprovement } from "./adoption-server";
import type { FactoryImprovementPublication } from "./publication-contracts";

const { access, admin } = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: admin }));
vi.mock("@/features/github/sandbox-token", () => ({ mintSandboxRepositoryToken: vi.fn() }));
vi.mock("./adoption-github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adoption-github")>()),
  createFactoryImprovementReviewVerifier: vi.fn(),
}));

const id = (number: number) => `6400abcd-0000-4000-8000-${String(number).padStart(12, "0")}`;
const ids = {
  workspaceId: id(1),
  factoryId: id(2),
  actorUserId: id(3),
  proposalId: id(4),
  proposalRevisionId: id(5),
};
const pipelineId = id(6);
const repositoryId = id(7);
const skillRevisionId = id(8);
const memberId = id(9);
const installationId = id(10);
const repositoryFullName = "fixture/definitions";
const origin = "https://wallie.test";
const token = "fixture-read-token";
const createdAt = "2026-01-01T12:00:00Z";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const fixtureCatalog: FactoryDefinitionCatalog = {
  workspaceId: ids.workspaceId,
  factoryId: ids.factoryId,
  pipelines: [{ id: pipelineId, workspaceId: ids.workspaceId }],
  repositories: [{ id: repositoryId, workspaceId: ids.workspaceId }],
  executionPolicyRevisions: [],
  deliveryPolicyRevisions: [],
  skills: [{ id: skillRevisionId, workspaceId: ids.workspaceId }],
  tools: [],
  approvers: [{ id: memberId, workspaceId: ids.workspaceId }],
  sandboxProviders: ["vercel"],
};

function compileDefinition(promptTemplateMd: string) {
  const result = compileFactoryDefinition(
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
          model: "gpt-5.5",
          effort: null,
          concurrencyLimit: 1,
          stallTimeoutMs: 90_000,
          maxRetries: 1,
          maxTurns: 12,
        },
        skills: [skillRevisionId],
        stages: [
          {
            id: id(11),
            slug: "review",
            name: "Review",
            promptTemplateMd,
            approverMemberIds: [memberId],
          },
        ],
      },
    },
    fixtureCatalog,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.definitionJson;
}

const exactBytes = compileDefinition("Review the exact benchmark evidence. ☃");
const alteredBytes = compileDefinition("Skip the review of the benchmark evidence.");
const proof = {
  repositoryNumericId: 37,
  pullNumber: 42,
  pullUrl: "https://github.com/fixture/definitions/pull/42",
  baseCommitSha: "a".repeat(40),
  headCommitSha: "b".repeat(40),
  mergeCommitSha: "c".repeat(40),
  reviewerId: 60,
  reviewerLogin: "independent-reviewer",
  reviewId: "61",
  reviewedAt: "2026-01-01T12:02:00Z",
  mergedAt: "2026-01-01T12:03:00Z",
  observedAt: "2026-01-01T12:04:00Z",
} satisfies FactoryImprovementReviewProof;

const targeted = {
  suiteRevisionId: id(12),
  experimentId: id(13),
  status: "qualified",
  independentTasks: 3,
  plannedPairs: 3,
  resolvedPairs: 3,
  coverageBps: 10_000,
  baseline: { passes: 2, passRateBps: 6667, meanCostUsd: null, p95LatencyMs: null },
  candidate: { passes: 3, passRateBps: 10_000, meanCostUsd: null, p95LatencyMs: null },
} satisfies FactoryImprovementPublication["comparisons"]["targeted"];

function fixture({
  hostedBytes = exactBytes,
  testedDigest = sha256(exactBytes),
  skillIsCurrent = true,
  recheckError,
  concurrentPublication,
  abortDuringCatalog = false,
}: {
  hostedBytes?: string;
  testedDigest?: string;
  skillIsCurrent?: boolean;
  recheckError?: ImprovementAdoptionGitHubError;
  concurrentPublication?: "matching-adoption" | "different-adoption" | "no-adoption";
  abortDuringCatalog?: boolean;
} = {}) {
  const trace: string[] = [];
  const activationRequests: unknown[] = [];
  const controller = new AbortController();
  const catalogSignals: AbortSignal[] = [];
  let publicationRead = false;
  const publication = {
    id: id(14),
    proposalId: ids.proposalId,
    proposalRevisionId: ids.proposalRevisionId,
    validationId: id(15),
    createdAt,
    base: { activationNumber: 4, revisionId: id(16), digest: "e".repeat(64) },
    candidate: { revisionId: id(17), digest: testedDigest },
    cohort: { id: id(18), diagnosisId: id(19), evidenceDigest: "f".repeat(64), citedCount: 3 },
    comparisons: {
      targeted,
      holdout: { ...targeted, suiteRevisionId: id(20), experimentId: id(21) },
    },
    target: {
      id: id(22),
      repositoryId,
      repositoryFullName,
      repositoryNumericId: proof.repositoryNumericId,
      installationId: 38,
      baseBranch: "wallie/definitions",
      headBranch: `wallie/improvements/${ids.factoryId}/${ids.proposalRevisionId}`,
      configPath: `.wallie/factory-definitions/${ids.factoryId}.json`,
    },
    baseCommitSha: proof.baseCommitSha,
    baseTreeSha: "d".repeat(40),
    headCommitSha: proof.headCommitSha,
    headTreeSha: "e".repeat(40),
    creationArmed: false,
    pullRequest: { number: proof.pullNumber, url: proof.pullUrl, state: "draft" },
    current: !concurrentPublication,
  } satisfies FactoryImprovementPublication;
  const adoption = {
    id: id(23),
    proposalId: ids.proposalId,
    proposalRevisionId: ids.proposalRevisionId,
    publicationId: publication.id,
    validationId: publication.validationId,
    actorMemberId: memberId,
    createdAt: "2026-01-01T12:05:00Z",
    baseline: publication.base,
    adopted: { activationNumber: 5, ...publication.candidate },
    review: proof,
    comparisons: publication.comparisons,
  } satisfies FactoryImprovementAdoption;
  const command = {
    publicationId: publication.id,
    expectedActivationNumber: publication.base.activationNumber,
    candidateDigest: testedDigest,
    headCommitSha: proof.headCommitSha,
  } satisfies FactoryImprovementAdoptionCommand;
  vi.mocked(mintSandboxRepositoryToken).mockResolvedValue(token);
  const read = vi.fn(async () => {
    trace.push("hosted bytes");
    return { definitionJson: hostedBytes, proof };
  });
  const assertCurrent = vi.fn(async (decision: FactoryImprovementReviewProof) => {
    trace.push("latest GitHub decision");
    expect(decision).toEqual(proof);
    if (recheckError) throw recheckError;
  });
  vi.mocked(createFactoryImprovementReviewVerifier).mockReturnValue({ read, assertCurrent });
  const client = createClient<Database>("https://factory.invalid", "fixture-service-role", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const { pathname, searchParams } = new URL(request.url);
        switch (pathname) {
          case "/rest/v1/rpc/get_factory_improvement_adoption":
            if (publicationRead && concurrentPublication === "matching-adoption") {
              return Response.json(adoption);
            }
            if (publicationRead && concurrentPublication === "different-adoption") {
              return Response.json({ ...adoption, publicationId: id(24) });
            }
            return Response.json(null);
          case "/rest/v1/rpc/get_factory_improvement_publication":
            publicationRead = true;
            return Response.json(publication);
          case "/rest/v1/rpc/adopt_factory_improvement":
            trace.push("activation");
            activationRequests.push(await request.json());
            return Response.json({ adoption, replay: false });
          case "/rest/v1/factories":
            expect(searchParams.get("workspace_id")).toBe(`eq.${ids.workspaceId}`);
            expect(searchParams.get("id")).toBe(`eq.${ids.factoryId}`);
            return Response.json({ id: ids.factoryId });
          case "/rest/v1/workspace_members":
            return Response.json([{ id: memberId }]);
          case "/rest/v1/pipelines":
            return Response.json([{ id: pipelineId, name: "Fixture workflow" }]);
          case "/rest/v1/github_repositories":
            return Response.json([
              {
                id: repositoryId,
                full_name: repositoryFullName,
                github_installation_id: installationId,
              },
            ]);
          case "/rest/v1/github_installations":
            return Response.json([{ id: installationId }]);
          case "/rest/v1/execution_policy_revisions":
          case "/rest/v1/delivery_policy_revisions":
            return Response.json([]);
          case "/rest/v1/factory_skill_revisions":
            trace.push("scoped skill catalog");
            catalogSignals.push(request.signal);
            if (abortDuringCatalog) {
              controller.abort(new DOMException("Fixture deadline", "TimeoutError"));
              request.signal.throwIfAborted();
            }
            expect(searchParams.get("workspace_id")).toBe(`eq.${ids.workspaceId}`);
            expect(searchParams.get("factory_id")).toBe(`eq.${ids.factoryId}`);
            expect(searchParams.get("id")).toBe(`in.(${skillRevisionId})`);
            expect(searchParams.get("revoked_at")).toBe("is.null");
            return Response.json(skillIsCurrent ? [{ id: skillRevisionId }] : []);
          default:
            throw new Error(`Unexpected adoption fixture request ${pathname}`);
        }
      },
    },
  });
  const scope = { ...ids, client, signal: controller.signal };
  access.mockResolvedValue({
    ok: true,
    context: { supabase: client, user: { id: ids.actorUserId } },
  });
  admin.mockReturnValue(client);
  return {
    adopt: () => adoptFactoryImprovement(scope, command),
    submit: () => {
      const { workspaceId, factoryId, proposalId, proposalRevisionId } = ids;
      const endpoint = `/api/workspaces/${workspaceId}/factories/${factoryId}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}/adoption`;
      const request = new Request(`${origin}${endpoint}`, {
        method: "POST",
        headers: { origin, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      return POST(request, { params: Promise.resolve(ids) });
    },
    adoption,
    trace,
    activationRequests,
    catalogSignals,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRateLimitsForTesting();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  vi.stubEnv("WALLIE_ENABLED_SANDBOX_PROVIDERS", "vercel");
});

afterEach(() => vi.unstubAllEnvs());

describe("adoptFactoryImprovement", () => {
  it("activates through the first POST using the exact reviewed bytes and fresh authority", async () => {
    const { submit, adoption, trace, activationRequests } = fixture();
    const response = await submit();
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ adoption, replay: false });
    expect(trace).toEqual([
      "hosted bytes",
      "scoped skill catalog",
      "latest GitHub decision",
      "activation",
    ]);
    expect(mintSandboxRepositoryToken).toHaveBeenCalledWith({
      installationId: 38,
      repositoryId: proof.repositoryNumericId,
      repositoryFullName,
      purpose: "pull-request-read",
      signal: expect.any(AbortSignal),
    });
    expect(createFactoryImprovementReviewVerifier).toHaveBeenCalledWith({
      publication: expect.objectContaining({
        id: adoption.publicationId,
        headCommitSha: proof.headCommitSha,
        candidate: { revisionId: adoption.adopted.revisionId, digest: sha256(exactBytes) },
      }),
      token,
      signal: expect.any(AbortSignal),
    });
    expect(activationRequests).toEqual([
      {
        p_workspace_id: ids.workspaceId,
        p_factory_id: ids.factoryId,
        p_actor_user_id: ids.actorUserId,
        p_proposal_id: ids.proposalId,
        p_proposal_revision_id: ids.proposalRevisionId,
        p_publication_id: adoption.publicationId,
        p_expected_activation_number: 4,
        p_candidate_digest: sha256(exactBytes),
        p_head_commit_sha: proof.headCommitSha,
        p_reviewed_definition_json: exactBytes,
        p_review: proof,
        p_enabled_sandbox_providers: ["vercel"],
        p_required_probes: [
          "git",
          "node",
          "packageManager",
          "agentCli",
          "playwrightPackage",
          "chromium",
          "screenshotSmoke",
          "codexExternalSandbox",
        ],
      },
    ]);
  });

  it("sends no activation when the recheck detects revoked authority or a moved head", async () => {
    const { adopt, trace, activationRequests } = fixture({
      recheckError: new ImprovementAdoptionGitHubError("review_conflict"),
    });
    await expect(adopt()).rejects.toMatchObject({ code: "PT409" });
    expect(trace).toEqual(["hosted bytes", "scoped skill catalog", "latest GitHub decision"]);
    expect(activationRequests).toEqual([]);
  });

  it("returns the exact receipt when another request adopts between the adoption and publication reads", async () => {
    const { adopt, adoption, activationRequests } = fixture({
      concurrentPublication: "matching-adoption",
    });
    await expect(adopt()).resolves.toEqual({ adoption, replay: true });
    expect(mintSandboxRepositoryToken).not.toHaveBeenCalled();
    expect(activationRequests).toEqual([]);
  });

  it.each(["different-adoption", "no-adoption"] as const)(
    "rejects a stale publication with %s",
    async (concurrentPublication) => {
      const { adopt, activationRequests } = fixture({ concurrentPublication });
      await expect(adopt()).rejects.toMatchObject({ code: "PT409" });
      expect(mintSandboxRepositoryToken).not.toHaveBeenCalled();
      expect(activationRequests).toEqual([]);
    },
  );

  it.each([
    {
      kind: "changed candidate bytes",
      hostedBytes: alteredBytes,
      testedDigest: sha256(exactBytes),
    },
    {
      kind: "invalid JSON with a matching digest",
      hostedBytes: "not JSON",
      testedDigest: sha256("not JSON"),
    },
  ])("sends no activation for $kind", async (options) => {
    const { adopt, trace, activationRequests } = fixture(options);
    await expect(adopt()).rejects.toMatchObject({ code: "PT422" });
    expect(trace).toEqual(["hosted bytes"]);
    expect(activationRequests).toEqual([]);
  });

  it("sends no activation if the reviewed bytes no longer compile against the scoped catalog", async () => {
    const { adopt, trace, activationRequests } = fixture({ skillIsCurrent: false });
    await expect(adopt()).rejects.toMatchObject({ code: "PT422" });
    expect(trace).toEqual(["hosted bytes", "scoped skill catalog"]);
    expect(activationRequests).toEqual([]);
  });

  it("aborts the in-flight catalog read and returns a retryable error when the adoption deadline expires", async () => {
    const { submit, trace, activationRequests, catalogSignals } = fixture({
      abortDuringCatalog: true,
    });
    const response = await submit();
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Retry the same proposal revision."),
    });
    expect(catalogSignals.map((signal) => signal.aborted)).toEqual([true]);
    expect(trace).toEqual(["hosted bytes", "scoped skill catalog"]);
    expect(activationRequests).toEqual([]);
  });
});
