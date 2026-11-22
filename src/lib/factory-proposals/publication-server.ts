import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import {
  CanonicalPrApiError,
  createCanonicalPrApi,
  type CanonicalPullRequest,
} from "@/lib/pipeline/canonical-pr-api";
import type { Database } from "@/lib/supabase/database.types";

import { factoryProposalUuidSchema as id } from "./contracts";
import {
  factoryImprovementPublicationSchema,
  improvementPublicationTargetSchema,
  type FactoryImprovementPublication,
  type ImprovementPublicationTargetCommand,
} from "./publication-contracts";
import {
  createImprovementPublicationGitHub,
  ImprovementPublicationGitHubError,
} from "./publication-github";

type FactoryScope = {
  client: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
  actorUserId: string;
  signal: AbortSignal;
};
type PublicationScope = FactoryScope & { proposalId: string; proposalRevisionId: string };
type PublicationDependencies = {
  getToken: (publication: FactoryImprovementPublication) => Promise<string>;
  fetcher: typeof fetch;
};
type PublicationResult = {
  publication: FactoryImprovementPublication;
  state: "pending" | "published";
  replay: boolean;
};
type Step =
  | { action: "freeze_base"; values: { baseCommitSha: string; baseTreeSha: string } }
  | { action: "pin_head"; values: { headCommitSha: string; headTreeSha: string } }
  | {
      action: "record_pr";
      values: { pullNumber: number; pullUrl: string; pullState: CanonicalPullRequest["state"] };
    }
  | {
      action: "authorize_head" | "arm_create" | "reset_create" | "release";
      values: Record<string, never>;
    };

const claimSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("claimed"),
    publication: factoryImprovementPublicationSchema,
    claim: z.object({ id, expiresAt: z.string().datetime({ offset: true }) }),
    candidateDefinitionJson: z.string().nullable(),
  }),
  z.object({
    status: z.enum(["published", "busy"]),
    publication: factoryImprovementPublicationSchema,
    claim: z.null(),
    candidateDefinitionJson: z.null(),
  }),
]);

class PublicationError extends Error {
  constructor(readonly code: "PT409" | "PT502") {
    super("Could not verify the factory improvement publication.");
  }
}

function factoryArguments({ workspaceId, factoryId, actorUserId }: FactoryScope) {
  return { p_workspace_id: workspaceId, p_factory_id: factoryId, p_actor_user_id: actorUserId };
}

function proposalArguments(scope: PublicationScope) {
  return {
    ...factoryArguments(scope),
    p_proposal_id: scope.proposalId,
    p_proposal_revision_id: scope.proposalRevisionId,
  };
}

function publicationInScope(publication: FactoryImprovementPublication, scope: PublicationScope) {
  if (
    publication.proposalId !== scope.proposalId ||
    publication.proposalRevisionId !== scope.proposalRevisionId ||
    publication.target.headBranch !==
      `wallie/improvements/${scope.factoryId}/${scope.proposalRevisionId}` ||
    publication.target.configPath !== `.wallie/factory-definitions/${scope.factoryId}.json`
  ) {
    throw new PublicationError("PT409");
  }
  return publication;
}

export async function setFactoryImprovementPublicationTarget(
  scope: FactoryScope,
  command: ImprovementPublicationTargetCommand,
) {
  const { data, error, status } = await scope.client
    .rpc("set_factory_improvement_publication_target", {
      ...factoryArguments(scope),
      p_repository_id: command.repositoryId,
      p_base_branch: command.baseBranch,
    })
    .abortSignal(scope.signal);
  if (error) throw status === 0 ? new PublicationError("PT502") : error;
  const target = improvementPublicationTargetSchema.parse(data);
  if (
    target.repositoryId !== command.repositoryId ||
    target.baseBranch !== command.baseBranch ||
    target.configPath !== `.wallie/factory-definitions/${scope.factoryId}.json`
  )
    throw new PublicationError("PT409");
  return target;
}

export async function readFactoryImprovementPublication(scope: PublicationScope) {
  const { data, error, status } = await scope.client
    .rpc("get_factory_improvement_publication", proposalArguments(scope))
    .abortSignal(scope.signal);
  if (error) throw status === 0 ? new PublicationError("PT502") : error;
  return data === null
    ? null
    : publicationInScope(factoryImprovementPublicationSchema.parse(data), scope);
}

function comparisonLine(
  label: string,
  comparison: FactoryImprovementPublication["comparisons"]["targeted"],
) {
  const percent = (value: number | null) => (value === null ? "unavailable" : `${value / 100}%`);
  const { baseline, candidate } = comparison;
  return `| ${label} | \`${comparison.experimentId}\` | ${comparison.resolvedPairs}/${comparison.plannedPairs} | ${comparison.independentTasks} | ${percent(baseline.passRateBps)} → ${percent(candidate.passRateBps)} | ${baseline.meanCostUsd ?? "unavailable"} → ${candidate.meanCostUsd ?? "unavailable"} | ${baseline.p95LatencyMs ?? "unavailable"} → ${candidate.p95LatencyMs ?? "unavailable"} |`;
}

function pullRequestBody(publication: FactoryImprovementPublication) {
  const { base, candidate, cohort, comparisons, proposalRevisionId, validationId } = publication;
  return `## Tested factory configuration

- Proposal revision \`${proposalRevisionId}\`
- Validation receipt \`${validationId}\`
- Baseline activation ${base.activationNumber}, definition \`${base.revisionId}\`, SHA-256 \`${base.digest}\`
- Candidate definition \`${candidate.revisionId}\`, SHA-256 \`${candidate.digest}\`
- Failure cohort \`${cohort.id}\` and diagnosis \`${cohort.diagnosisId}\` cite ${cohort.citedCount} retained runs. Evidence digest \`${cohort.evidenceDigest}\`

| Suite | Frozen experiment | Compared pairs | Independent tasks | Pass rate | Mean cost (USD) | P95 latency (ms) |
| --- | --- | --- | --- | --- | --- | --- |
${comparisonLine("Targeted", comparisons.targeted)}
${comparisonLine("Held out", comparisons.holdout)}

## Expected rollout

An authorized person reviews the exact candidate and explicitly adopts it in Wallie after review. Adoption applies to future factory admissions. Compare their outcomes with the recorded baseline and use the shared factory rollback if outcomes degrade.
`;
}

function publicationFailure(error: unknown) {
  if (error instanceof PublicationError) return error;
  if (error instanceof CanonicalPrApiError) {
    return new PublicationError(
      error.code === "pr_identity_conflict" || error.code === "pr_multiple_matches"
        ? "PT409"
        : "PT502",
    );
  }
  if (error instanceof ImprovementPublicationGitHubError) {
    const identityConflict = [
      "repository_mismatch",
      "base_mismatch",
      "head_conflict",
      "pull_request_conflict",
    ].includes(error.code);
    return new PublicationError(identityConflict ? "PT409" : "PT502");
  }
  if (error && typeof error === "object" && "code" in error) return error;
  if (error instanceof Error) return new PublicationError("PT502");
  return error;
}

export async function publishFactoryImprovement(
  scope: PublicationScope,
  dependencies: Partial<PublicationDependencies> = {},
): Promise<PublicationResult> {
  const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(100_000)]);
  const { data, error, status } = await scope.client
    .rpc("claim_factory_improvement_publication", proposalArguments(scope))
    .abortSignal(signal);
  if (error) throw status === 0 ? new PublicationError("PT502") : error;
  const claim = claimSchema.parse(data);
  let publication = publicationInScope(claim.publication, scope);
  if (claim.status !== "claimed") {
    return {
      publication,
      state: claim.status === "published" ? "published" : "pending",
      replay: true,
    };
  }
  const claimId = claim.claim.id;
  const publicationId = publication.id;
  const target = publication.target;
  const candidateDigest = publication.candidate.digest;
  const definitionJson = claim.candidateDefinitionJson;

  async function advance(step: Step, stepSignal = signal) {
    const { data, error, status } = await scope.client
      .rpc("advance_factory_improvement_publication", {
        ...factoryArguments(scope),
        p_publication_id: publicationId,
        p_claim_id: claimId,
        p_action: step.action,
        p_values: step.values,
      })
      .abortSignal(stepSignal);
    if (error) throw status === 0 ? new PublicationError("PT502") : error;
    const advanced = publicationInScope(factoryImprovementPublicationSchema.parse(data), scope);
    if (advanced.id !== publicationId) throw new PublicationError("PT409");
    publication = advanced;
  }

  try {
    const token = await (dependencies.getToken
      ? dependencies.getToken(publication)
      : mintSandboxRepositoryToken({
          installationId: target.installationId,
          repositoryId: target.repositoryNumericId,
          repositoryFullName: target.repositoryFullName,
          purpose: "execution",
          signal,
        }));
    signal.throwIfAborted();
    const git = createImprovementPublicationGitHub({
      target,
      token,
      fetcher: dependencies.fetcher,
    });
    const pull = createCanonicalPrApi({
      repositoryFullName: target.repositoryFullName,
      repositoryNumericId: target.repositoryNumericId,
      branchName: target.headBranch,
      baseBranch: target.baseBranch,
      token,
      signal,
      fetcher: dependencies.fetcher,
    });

    async function verifyAndRecord(number: number, replay: boolean): Promise<PublicationResult> {
      const { baseCommitSha, baseTreeSha, headCommitSha, headTreeSha } = publication;
      if (!baseCommitSha || !baseTreeSha || !headCommitSha || !headTreeSha) {
        throw new PublicationError("PT409");
      }
      const canonical = await git.verifyPullRequest({
        pullNumber: number,
        baseCommitSha,
        headCommitSha,
        signal,
      });
      if (canonical.draft) throw new PublicationError("PT409");
      await git.verifyHead({
        base: {
          commitSha: baseCommitSha,
          treeSha: baseTreeSha,
          fileSha256: publication.base.digest,
        },
        head: { commitSha: headCommitSha, treeSha: headTreeSha },
        candidateDigest,
        signal,
        requireRef: canonical.state === "open",
      });
      await advance({
        action: "record_pr",
        values: {
          pullNumber: canonical.number,
          pullUrl: `https://github.com/${target.repositoryFullName}/pull/${canonical.number}`,
          pullState: canonical.state,
        },
      });
      return { publication, state: "published", replay };
    }

    if (publication.creationArmed) {
      const existing = await pull.find();
      return existing
        ? await verifyAndRecord(existing.number, true)
        : { publication, state: "pending", replay: true };
    }
    if (
      definitionJson === null ||
      !readVerifiedFactoryDefinition(definitionJson, candidateDigest)
    ) {
      throw new PublicationError("PT409");
    }

    async function readMatchingBase() {
      const base = await git.readBase(signal);
      if (
        base.fileSha256 !== publication.base.digest ||
        target.baseBranch === base.defaultBranch ||
        (publication.baseCommitSha !== null &&
          (base.commitSha !== publication.baseCommitSha ||
            base.treeSha !== publication.baseTreeSha))
      )
        throw new PublicationError("PT409");
      return base;
    }

    const base = await readMatchingBase();
    if (!publication.baseCommitSha) {
      await advance({
        action: "freeze_base",
        values: { baseCommitSha: base.commitSha, baseTreeSha: base.treeSha },
      });
    }
    let headCommitSha = publication.headCommitSha;
    let headTreeSha = publication.headTreeSha;
    if (!headCommitSha || !headTreeSha) {
      const prepared = await git.prepareHead({
        base,
        definitionJson,
        candidateDigest,
        message: `Wallie factory improvement ${scope.proposalRevisionId}`,
        committedAt: publication.createdAt,
        signal,
      });
      await advance({
        action: "pin_head",
        values: { headCommitSha: prepared.commitSha, headTreeSha: prepared.treeSha },
      });
      headCommitSha = prepared.commitSha;
      headTreeSha = prepared.treeSha;
    }
    const head = { commitSha: headCommitSha, treeSha: headTreeSha };
    await advance({ action: "authorize_head", values: {} });
    await git.ensureHeadRef({ head, signal });
    await git.verifyHead({ base, head, candidateDigest, signal });
    if (await pull.find()) throw new PublicationError("PT409");
    await readMatchingBase();
    await advance({ action: "arm_create", values: {} });

    let created: CanonicalPullRequest;
    try {
      created = await pull.create({
        title: `Wallie factory improvement ${scope.proposalRevisionId}`,
        body: pullRequestBody(publication),
        draft: false,
      });
    } catch (error) {
      const retryCreationSafe = error instanceof CanonicalPrApiError && error.retryCreationSafe;
      let found: CanonicalPullRequest | null;
      try {
        found = await pull.find();
      } catch (reconcileError) {
        if (!retryCreationSafe) throw reconcileError;
        await advance({ action: "reset_create", values: {} });
        throw error;
      }
      if (found) return await verifyAndRecord(found.number, true);
      if (!retryCreationSafe) {
        return { publication, state: "pending", replay: true };
      }
      await advance({ action: "reset_create", values: {} });
      throw error;
    }
    return await verifyAndRecord(created.number, false);
  } catch (error) {
    throw publicationFailure(error);
  } finally {
    if (!publication.pullRequest) {
      // A fresh, bounded signal releases the lease after a disconnected caller.
      await advance({ action: "release", values: {} }, AbortSignal.timeout(5_000)).catch(
        () => undefined,
      );
    }
  }
}
