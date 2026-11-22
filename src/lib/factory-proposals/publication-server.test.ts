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
import { createImprovementPublicationGitHub } from "./publication-github";
import { publishFactoryImprovement } from "./publication-server";

vi.mock("@/lib/pipeline/canonical-pr-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pipeline/canonical-pr-api")>()),
  createCanonicalPrApi: vi.fn(),
}));
vi.mock("./publication-github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./publication-github")>()),
  createImprovementPublicationGitHub: vi.fn(),
}));

const id = (slot: number) => `63900000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const ids = {
  workspaceId: id(1),
  factoryId: id(2),
  actorUserId: id(3),
  proposalId: id(4),
  proposalRevisionId: id(5),
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
  draft: false,
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
});
type Action = z.infer<typeof action>["p_action"];
type Cleanup = Extract<Action, "reset_create" | "release">;

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture({ loseArmResponse = false }: { loseArmResponse?: boolean } = {}) {
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
  vi.mocked(createImprovementPublicationGitHub).mockReturnValue({
    readBase: vi.fn().mockResolvedValue(baseline),
    prepareHead: vi.fn(),
    ensureHeadRef: vi.fn().mockResolvedValue(undefined),
    verifyHead: vi.fn().mockResolvedValue(undefined),
    verifyPullRequest: vi.fn().mockResolvedValue(pullRequest),
  });

  let receipt: FactoryImprovementPublication = publication;
  let leased = false;
  let armResponseLost = false;
  const steps: Array<{ action: Action; signal: AbortSignal; aborted: boolean }> = [];
  const client = createClient<Database>("https://fixture.invalid", "test-database", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const signal = init?.signal ?? request.signal;
        const rpc = new URL(request.url).pathname;
        if (rpc === "/rest/v1/rpc/claim_factory_improvement_publication") {
          signal.throwIfAborted();
          if (leased) {
            return Response.json({
              status: "busy",
              publication: receipt,
              claim: null,
              candidateDefinitionJson: null,
            });
          }
          leased = true;
          return Response.json({
            status: "claimed",
            publication: receipt,
            claim: { id: id(20), expiresAt: "2026-11-22T07:02:00Z" },
            candidateDefinitionJson: definitionJson,
          });
        }

        expect(rpc).toBe("/rest/v1/rpc/advance_factory_improvement_publication");
        const { p_action: step } = action.parse(await request.json());
        steps.push({ action: step, signal, aborted: signal.aborted });
        signal.throwIfAborted();
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
            break;
          case "release":
            leased = false;
            break;
          case "record_pr":
            receipt = {
              ...receipt,
              pullRequest: {
                number: pullRequest.number,
                state: pullRequest.state,
                url: pullRequest.url,
              },
            };
            leased = false;
            break;
        }
        return Response.json(receipt);
      },
    },
  });

  return {
    caller,
    create,
    publish: (signal = caller.signal) =>
      publishFactoryImprovement(
        { ...ids, client, signal },
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
      expect(leased).toBe(false);
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
  scenario.expectCleanup(["reset_create", "release"]);
  expect(scenario.isArmed()).toBe(false);
});

it("resets an arm whose response was lost before GitHub create and allows a later retry", async () => {
  const scenario = fixture({ loseArmResponse: true });

  await expect(scenario.publish()).rejects.toMatchObject({ code: "PT502" });

  expect(scenario.create).not.toHaveBeenCalled();
  scenario.expectCleanup(["reset_create", "release"]);
  expect(scenario.isArmed()).toBe(false);

  await expect(scenario.publish(new AbortController().signal)).resolves.toMatchObject({
    state: "published",
    replay: false,
    publication: { pullRequest: { number: pullRequest.number } },
  });
  expect(scenario.create).toHaveBeenCalledOnce();
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
