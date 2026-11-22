import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CompiledFactoryDefinition } from "@/lib/factory-definitions/compiler";
import {
  CanonicalPrApiError,
  createCanonicalPrApi,
  type CanonicalPullRequest,
} from "@/lib/pipeline/canonical-pr-api";
import type { Database } from "@/lib/supabase/database.types";

import type { FactoryImprovementPublication } from "./publication-contracts";
import {
  createImprovementPublicationGitHub,
  ImprovementPublicationGitHubError,
} from "./publication-github";
import { publishFactoryImprovement, readFactoryImprovementPublication } from "./publication-server";

vi.mock("@/lib/pipeline/canonical-pr-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pipeline/canonical-pr-api")>()),
  createCanonicalPrApi: vi.fn(),
}));
vi.mock("./publication-github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./publication-github")>()),
  createImprovementPublicationGitHub: vi.fn(),
}));

const id = (slot: number) => `6390abcd-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const ids = {
  workspaceId: id(1),
  factoryId: id(2),
  actorUserId: id(3),
  proposalId: id(4),
  proposalRevisionId: id(5),
};
const uppercaseIds = {
  workspaceId: ids.workspaceId.toUpperCase(),
  factoryId: ids.factoryId.toUpperCase(),
  actorUserId: ids.actorUserId.toUpperCase(),
  proposalId: ids.proposalId.toUpperCase(),
  proposalRevisionId: ids.proposalRevisionId.toUpperCase(),
};
const definitionJson = JSON.stringify({
  schemaVersion: 1,
  kind: "serial",
  pipelineId: id(6),
  repositoryId: id(7),
  sandboxProvider: "vercel",
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: null,
    concurrencyLimit: 1,
    stallTimeoutMs: 900_000,
    maxRetries: 2,
    maxTurns: 100,
  },
  executionPolicyRevisionId: null,
  deliveryPolicyRevisionId: null,
  skillIds: [],
  toolIds: [],
  operatingRulesMd: "",
  operatingRuleStageIds: [],
  stages: [
    {
      id: id(8),
      name: "Review",
      slug: "review",
      description: "",
      promptTemplateMd: "Review the retained result.",
      anyoneCanApprove: false,
      approverMemberIds: [],
      previousStageIds: [],
    },
  ],
} satisfies CompiledFactoryDefinition);
const baseline = {
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  fileSha256: "c".repeat(64),
  defaultBranch: "main",
};
const head = { commitSha: "d".repeat(40), treeSha: "e".repeat(40) };
const createdAt = "2026-11-22T07:00:00Z";
const pullRequest = {
  number: 42,
  url: "https://github.com/fixture/definitions/pull/42",
  state: "open",
  draft: true,
  headSha: head.commitSha,
  updatedAt: createdAt,
} satisfies CanonicalPullRequest;
const arm = { passes: 3, passRateBps: 10_000, meanCostUsd: 0.1, p95LatencyMs: 500 };
const targeted = {
  suiteRevisionId: id(9),
  experimentId: id(10),
  status: "qualified",
  independentTasks: 3,
  plannedPairs: 3,
  resolvedPairs: 3,
  coverageBps: 10_000,
  baseline: arm,
  candidate: arm,
} satisfies FactoryImprovementPublication["comparisons"]["targeted"];
const publication = {
  id: id(11),
  proposalId: ids.proposalId,
  proposalRevisionId: ids.proposalRevisionId,
  validationId: id(12),
  createdAt,
  base: { activationNumber: 1, revisionId: id(13), digest: baseline.fileSha256 },
  candidate: {
    revisionId: id(14),
    digest: createHash("sha256").update(definitionJson).digest("hex"),
  },
  cohort: { id: id(15), diagnosisId: id(16), evidenceDigest: "f".repeat(64), citedCount: 3 },
  comparisons: {
    targeted,
    holdout: { ...targeted, suiteRevisionId: id(17), experimentId: id(18) },
  },
  target: {
    id: id(19),
    repositoryId: id(7),
    repositoryFullName: "fixture/definitions",
    repositoryNumericId: 37,
    installationId: 38,
    baseBranch: "test/definitions",
    headBranch: `wallie/improvements/${ids.factoryId}/${ids.proposalRevisionId}`,
    configPath: `.wallie/factory-definitions/${ids.factoryId}.json`,
  },
  baseCommitSha: baseline.commitSha,
  baseTreeSha: baseline.treeSha,
  headCommitSha: head.commitSha,
  headTreeSha: head.treeSha,
  creationArmed: false,
  pullRequest: null,
  current: true,
} satisfies FactoryImprovementPublication;
const action = z.object({
  p_action: z.enum(["authorize_head", "arm_create", "reset_create", "release", "record_pr"]),
  p_claim_id: z.string().uuid(),
  p_values: z.unknown(),
});
const pullValues = z.object({
  pullNumber: z.number().int().positive(),
  pullState: z.enum(["draft", "open", "closed", "merged"]),
  pullUrl: z.string().url(),
});
type Action = z.infer<typeof action>["p_action"];
type Cleanup = Extract<Action, "reset_create" | "release">;

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture({
  loseArmResponse = false,
  inputIds = ids,
  hostedHeadSha = head.commitSha,
}: {
  loseArmResponse?: boolean;
  inputIds?: typeof ids;
  hostedHeadSha?: string;
} = {}) {
  const caller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const create = vi
    .fn<ReturnType<typeof createCanonicalPrApi>["create"]>()
    .mockResolvedValue(pullRequest);
  vi.mocked(createCanonicalPrApi).mockImplementation(({ signal }) => ({
    find: async () => {
      signal?.throwIfAborted();
      return null;
    },
    get: vi.fn(),
    create,
  }));
  const verifyHead = vi.fn().mockResolvedValue(undefined);
  const verifyPullRequest = vi
    .fn<ReturnType<typeof createImprovementPublicationGitHub>["verifyPullRequest"]>()
    .mockImplementation(async ({ headCommitSha }) => {
      if (headCommitSha !== hostedHeadSha) {
        throw new ImprovementPublicationGitHubError("pull_request_conflict");
      }
      return { ...pullRequest, headSha: hostedHeadSha };
    });
  vi.mocked(createImprovementPublicationGitHub).mockReturnValue({
    readBase: vi.fn().mockResolvedValue(baseline),
    prepareHead: vi.fn(),
    ensureHeadRef: vi.fn().mockResolvedValue(undefined),
    verifyHead,
    verifyPullRequest,
  });

  let receipt: FactoryImprovementPublication = publication;
  let activeClaimId: string | null = null;
  let claims = 0;
  let armResponseLost = false;
  const steps: Array<{ action: Action; claimId: string; signal: AbortSignal; aborted: boolean }> =
    [];
  const requests: Array<{ rpc: string; args: unknown }> = [];
  const client = createClient<Database>("https://fixture.invalid", "test-database", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const signal = init?.signal ?? request.signal;
        const rpc = new URL(request.url).pathname;
        const args: unknown = await request.json();
        requests.push({ rpc, args });
        if (rpc === "/rest/v1/rpc/get_factory_improvement_publication") {
          return Response.json(receipt);
        }
        if (rpc === "/rest/v1/rpc/claim_factory_improvement_publication") {
          signal.throwIfAborted();
          if (activeClaimId || receipt.pullRequest) {
            return Response.json({
              status: receipt.pullRequest ? "published" : "busy",
              publication: receipt,
              claim: null,
              candidateDefinitionJson: null,
            });
          }
          activeClaimId = id(20 + ++claims);
          return Response.json({
            status: "claimed",
            publication: receipt,
            claim: { id: activeClaimId, expiresAt: "2026-11-22T07:02:00Z" },
            candidateDefinitionJson: definitionJson,
          });
        }

        expect(rpc).toBe("/rest/v1/rpc/advance_factory_improvement_publication");
        const { p_action: step, p_claim_id: claimId, p_values: values } = action.parse(args);
        steps.push({ action: step, claimId, signal, aborted: signal.aborted });
        signal.throwIfAborted();
        if (claimId !== activeClaimId) {
          return Response.json(
            { code: "PT409", message: "Publication claim expired." },
            { status: 409 },
          );
        }
        switch (step) {
          case "arm_create":
            expect(receipt.creationArmed).toBe(false);
            receipt = { ...receipt, creationArmed: true };
            if (loseArmResponse && !armResponseLost) {
              armResponseLost = true;
              caller.abort();
              // The database committed the arm immediately before the HTTP response was lost.
              signal.throwIfAborted();
            }
            break;
          case "reset_create":
            receipt = { ...receipt, creationArmed: false };
            activeClaimId = null;
            break;
          case "release":
            activeClaimId = null;
            break;
          case "record_pr": {
            const { pullNumber, pullState, pullUrl } = pullValues.parse(values);
            receipt = {
              ...receipt,
              pullRequest: {
                number: pullNumber,
                state: pullState,
                url: pullUrl,
              },
            };
            activeClaimId = null;
            break;
          }
        }
        return Response.json(receipt);
      },
    },
  });

  return {
    caller,
    create,
    requests,
    steps,
    verifyHead,
    verifyPullRequest,
    read: () => readFactoryImprovementPublication({ ...inputIds, client, signal: caller.signal }),
    publish: (signal = caller.signal) =>
      publishFactoryImprovement(
        { ...inputIds, client, signal },
        { getToken: async () => "local-fixture" },
      ),
    expectCleanup(expected: Cleanup[]) {
      const cleanup = steps.filter(
        ({ action }) => action === "reset_create" || action === "release",
      );
      expect(cleanup.map(({ action }) => action)).toEqual(expected);
      const armRequest = steps.find(({ action }) => action === "arm_create");
      expect(armRequest?.signal.aborted).toBe(true);
      for (const call of cleanup) {
        expect(call.signal).not.toBe(armRequest?.signal);
        expect(call.aborted).toBe(false);
        expect(
          timeout.mock.calls.some(
            ([ms], index) =>
              ms > 0 && ms <= 5_000 && timeout.mock.results[index]?.value === call.signal,
          ),
        ).toBe(true);
      }
      expect(activeClaimId).toBeNull();
    },
    isArmed: () => receipt.creationArmed,
  };
}

it("resets a definitively rejected GitHub create and releases the lease after caller abort", async () => {
  const scenario = fixture();
  scenario.create.mockImplementationOnce(async () => {
    scenario.caller.abort();
    throw new CanonicalPrApiError("pr_creation_rejected", { retryCreationSafe: true, status: 403 });
  });

  await expect(scenario.publish()).rejects.toMatchObject({ code: "PT502" });

  expect(scenario.create).toHaveBeenCalledOnce();
  scenario.expectCleanup(["reset_create"]);
  expect(scenario.isArmed()).toBe(false);
});

it("resets an arm whose response was lost before GitHub create and allows a later retry", async () => {
  const scenario = fixture({ loseArmResponse: true });

  await expect(scenario.publish()).rejects.toMatchObject({ code: "PT502" });

  expect(scenario.create).not.toHaveBeenCalled();
  scenario.expectCleanup(["reset_create"]);
  expect(scenario.isArmed()).toBe(false);

  await expect(scenario.publish(new AbortController().signal)).resolves.toMatchObject({
    state: "published",
    replay: false,
    publication: { pullRequest: { number: pullRequest.number } },
  });
  expect(scenario.create).toHaveBeenCalledOnce();
  const armedClaims = scenario.steps.filter(({ action }) => action === "arm_create");
  expect(armedClaims).toHaveLength(2);
  expect(armedClaims[0].claimId).not.toBe(armedClaims[1].claimId);
});

it("releases the lease after an uncertain GitHub create abort without clearing the arm", async () => {
  const scenario = fixture();
  scenario.create.mockImplementationOnce(async () => {
    scenario.caller.abort();
    throw new CanonicalPrApiError("pr_creation_uncertain");
  });

  await expect(scenario.publish()).rejects.toThrow();

  scenario.expectCleanup(["release"]);
  expect(scenario.isArmed()).toBe(true);
  await expect(scenario.publish(new AbortController().signal)).resolves.toMatchObject({
    state: "pending",
    replay: true,
  });
  expect(scenario.create).toHaveBeenCalledOnce();
});

it("normalizes uppercase route UUIDs for RPCs, hosted refs, and the stored receipt", async () => {
  const scenario = fixture({ inputIds: uppercaseIds });

  await expect(scenario.read()).resolves.toMatchObject(publication);
  await expect(scenario.publish()).resolves.toMatchObject({
    state: "published",
    publication: { proposalId: ids.proposalId, proposalRevisionId: ids.proposalRevisionId },
  });

  for (const { rpc, args } of scenario.requests) {
    expect(args).toMatchObject({
      p_workspace_id: ids.workspaceId,
      p_factory_id: ids.factoryId,
      p_actor_user_id: ids.actorUserId,
      ...(rpc.endsWith("/advance_factory_improvement_publication")
        ? {}
        : { p_proposal_id: ids.proposalId, p_proposal_revision_id: ids.proposalRevisionId }),
    });
  }
  expect(createImprovementPublicationGitHub).toHaveBeenLastCalledWith(
    expect.objectContaining({ target: publication.target }),
  );
});

it("creates a draft and records it only after verifying the pinned hosted PR and retained ref", async () => {
  const scenario = fixture();

  await expect(scenario.publish()).resolves.toMatchObject({
    state: "published",
    replay: false,
    publication: { pullRequest: { number: pullRequest.number, state: "draft" } },
  });

  expect(scenario.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ draft: true }));
  expect(scenario.verifyPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      pullNumber: pullRequest.number,
      baseCommitSha: baseline.commitSha,
      headCommitSha: head.commitSha,
    }),
  );
  expect(scenario.verifyHead).toHaveBeenLastCalledWith(
    expect.objectContaining({ head, requireRef: true }),
  );
});

it("keeps a moved hosted draft out of the receipt and preserves the armed creation", async () => {
  const scenario = fixture({ hostedHeadSha: "1".repeat(40) });

  await expect(scenario.publish()).rejects.toMatchObject({ code: "PT409" });

  expect(scenario.create).toHaveBeenCalledOnce();
  expect(scenario.verifyPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({ headCommitSha: head.commitSha }),
  );
  expect(scenario.steps.map(({ action }) => action)).toEqual([
    "authorize_head",
    "arm_create",
    "release",
  ]);
  await expect(scenario.read()).resolves.toMatchObject({ pullRequest: null, creationArmed: true });
});
