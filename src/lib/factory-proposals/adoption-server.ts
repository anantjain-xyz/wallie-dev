import "server-only";

import { z } from "zod";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import {
  factoryActivationRequirements,
  loadFactoryDefinitionCatalog,
} from "@/lib/factory-definitions/authority";
import { factoryComponentRevisionsForBundle } from "@/lib/factory-definitions/compiler";
import {
  readVerifiedFactoryDefinition,
  recompileStoredFactoryDefinition,
} from "@/lib/factory-definitions/stored-definition";

import {
  factoryImprovementAdoptionSchema,
  factoryImprovementReviewProofSchema,
  type FactoryImprovementAdoption,
  type FactoryImprovementAdoptionCommand,
} from "./adoption-contracts";
import {
  createFactoryImprovementReviewVerifier,
  ImprovementAdoptionGitHubError,
} from "./adoption-github";
import {
  normalizedPublicationScope,
  proposalArguments,
  readFactoryImprovementPublication,
  type PublicationScope,
} from "./publication-server";

const adoptionResult = z.object({
  adoption: factoryImprovementAdoptionSchema,
  replay: z.boolean(),
});

class AdoptionError extends Error {
  constructor(readonly code: "42501" | "P0002" | "PT409" | "PT422" | "PT502") {
    super("Could not authorize the reviewed improvement.");
  }
}

function inScope(adoption: FactoryImprovementAdoption, scope: PublicationScope) {
  if (
    adoption.proposalId !== scope.proposalId ||
    adoption.proposalRevisionId !== scope.proposalRevisionId
  ) {
    throw new AdoptionError("PT409");
  }
  return adoption;
}

function matchesCommand(
  adoption: FactoryImprovementAdoption,
  command: FactoryImprovementAdoptionCommand,
) {
  return (
    adoption.publicationId === command.publicationId &&
    adoption.baseline.activationNumber === command.expectedActivationNumber &&
    adoption.adopted.digest === command.candidateDigest &&
    adoption.review.headCommitSha === command.headCommitSha
  );
}

export async function readFactoryImprovementAdoption(input: PublicationScope) {
  const scope = normalizedPublicationScope(input);
  const { data, error, status } = await scope.client
    .rpc("get_factory_improvement_adoption", proposalArguments(scope))
    .abortSignal(scope.signal);
  if (error) throw status === 0 ? new AdoptionError("PT502") : error;
  return data === null ? null : inScope(factoryImprovementAdoptionSchema.parse(data), scope);
}

export async function adoptFactoryImprovement(
  input: PublicationScope,
  requested: FactoryImprovementAdoptionCommand,
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(100_000)]);
  const scope = normalizedPublicationScope({ ...input, signal });
  const command = { ...requested, publicationId: requested.publicationId.toLowerCase() };
  const {
    data: manager,
    error: managerError,
    status: managerStatus,
  } = await scope.client
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", scope.workspaceId)
    .eq("user_id", scope.actorUserId)
    .eq("kind", "human")
    .eq("is_active", true)
    .in("role", ["owner", "admin"])
    .abortSignal(signal)
    .maybeSingle();
  if (managerError) throw managerStatus === 0 ? new AdoptionError("PT502") : managerError;
  if (!manager) throw new AdoptionError("42501");

  async function readReplay() {
    const adoption = await readFactoryImprovementAdoption(scope);
    if (!adoption) return null;
    if (!matchesCommand(adoption, command)) throw new AdoptionError("PT409");
    return { adoption, replay: true };
  }

  const existing = await readReplay();
  if (existing) return existing;

  const publication = await readFactoryImprovementPublication(scope);
  if (!publication?.pullRequest) throw new AdoptionError("P0002");
  if (!publication.current) {
    const replay = await readReplay();
    if (replay) return replay;
    throw new AdoptionError("PT409");
  }
  if (
    publication.id !== command.publicationId ||
    publication.base.activationNumber !== command.expectedActivationNumber ||
    publication.candidate.digest !== command.candidateDigest ||
    publication.headCommitSha !== command.headCommitSha
  ) {
    throw new AdoptionError("PT409");
  }

  const { target } = publication;
  const token = await mintSandboxRepositoryToken({
    installationId: target.installationId,
    repositoryId: target.repositoryNumericId,
    repositoryFullName: target.repositoryFullName,
    purpose: "pull-request-read",
    signal,
  }).catch(() => {
    throw new AdoptionError("PT502");
  });
  const verifier = createFactoryImprovementReviewVerifier({ publication, token, signal });
  const verified = await verifier.read().catch(mapVerificationFailure);
  const proof = factoryImprovementReviewProofSchema.parse(verified.proof);
  if (
    proof.repositoryNumericId !== target.repositoryNumericId ||
    proof.pullNumber !== publication.pullRequest.number ||
    proof.pullUrl !== publication.pullRequest.url ||
    proof.baseCommitSha !== publication.baseCommitSha ||
    proof.headCommitSha !== command.headCommitSha
  ) {
    throw new AdoptionError("PT409");
  }

  const bundle = readVerifiedFactoryDefinition(verified.definitionJson, command.candidateDigest);
  if (!bundle) throw new AdoptionError("PT422");
  const catalog = await loadFactoryDefinitionCatalog(
    scope.client,
    {
      workspaceId: scope.workspaceId,
      factoryId: scope.factoryId,
      ...factoryComponentRevisionsForBundle(bundle),
    },
    signal,
  ).catch((error: unknown) => {
    if (signal.aborted) throw new AdoptionError("PT502");
    throw error;
  });
  const compiled = recompileStoredFactoryDefinition(
    verified.definitionJson,
    command.candidateDigest,
    catalog,
  );
  if (!compiled.ok) throw new AdoptionError("PT422");
  const requirements = factoryActivationRequirements(compiled.bundle);

  await verifier.assertCurrent(proof).catch(mapVerificationFailure);
  const { data, error, status } = await scope.client
    .rpc("adopt_factory_improvement", {
      ...proposalArguments(scope),
      p_publication_id: command.publicationId,
      p_expected_activation_number: command.expectedActivationNumber,
      p_candidate_digest: command.candidateDigest,
      p_head_commit_sha: command.headCommitSha,
      p_reviewed_definition_json: compiled.definitionJson,
      p_review: proof,
      p_enabled_sandbox_providers: requirements.enabledSandboxProviders,
      p_required_probes: requirements.requiredProbes,
    })
    .abortSignal(signal);
  if (error) throw status === 0 ? new AdoptionError("PT502") : error;
  const accepted = adoptionResult.parse(data);
  if (!matchesCommand(inScope(accepted.adoption, scope), command)) {
    throw new AdoptionError("PT409");
  }
  return accepted;
}

function mapVerificationFailure(error: unknown): never {
  throw new AdoptionError(
    error instanceof ImprovementAdoptionGitHubError && error.code === "review_conflict"
      ? "PT409"
      : "PT502",
  );
}
