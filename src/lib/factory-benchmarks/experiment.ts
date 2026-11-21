import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { loadFactoryDefinitionCatalog } from "@/lib/factory-definitions/authority";
import { factoryComponentRevisionsForBundle } from "@/lib/factory-definitions/compiler";
import { resolveFactoryExecutionProfile } from "@/lib/factory-definitions/execution-profile";
import {
  readVerifiedFactoryDefinition,
  recompileStoredFactoryDefinition,
} from "@/lib/factory-definitions/stored-definition";
import type { Database } from "@/lib/supabase/database.types";

import {
  benchmarkEvaluationPlanSchema,
  matchesBenchmarkEvaluationPlan,
} from "./experiment-evaluation-contracts";

const plannedWorkerRuntime = "node";
const maxPlannedTrials = 10_000;
const repetitionCount = z.number().int().min(1).max(100);
const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const freezeBenchmarkExperimentRequestSchema = z
  .strictObject({
    experimentId: id,
    suiteRevisionId: id,
    policyRevisionId: id,
    definitionRevisionIds: z
      .array(id)
      .min(1)
      .max(maxPlannedTrials)
      .refine((ids) => new Set(ids).size === ids.length, "Select each definition revision once.")
      .transform((ids) => ids.sort()),
    repetitions: repetitionCount,
    seed: z.number().int().min(0).max(2_147_483_647),
    timeoutMs: z.number().int().min(1_000).max(1_800_000),
    evaluation: benchmarkEvaluationPlanSchema.optional(),
  })
  .refine(
    ({ definitionRevisionIds, repetitions }) =>
      definitionRevisionIds.length * repetitions <= maxPlannedTrials,
    "Reduce candidates or repetitions to fit the 10,000-trial limit.",
  );

const count = z.number().int().min(0).max(maxPlannedTrials);
const benchmarkExperimentSnapshotSchema = z
  .object({
    experimentId: id,
    suiteRevisionId: id,
    policyRevisionId: id,
    taskCount: count.min(1),
    candidateCount: count.min(1),
    repetitions: repetitionCount,
    expectedTrialCount: count.min(1),
    materializedTrialCount: count.min(1),
    eligibleTrialCount: count,
    ineligibleTrialCount: count,
    evaluation: benchmarkEvaluationPlanSchema.optional(),
  })
  .refine((snapshot) => {
    const {
      taskCount,
      candidateCount,
      repetitions,
      expectedTrialCount,
      materializedTrialCount,
      eligibleTrialCount,
      ineligibleTrialCount,
    } = snapshot;
    return (
      expectedTrialCount === taskCount * candidateCount * repetitions &&
      materializedTrialCount === expectedTrialCount &&
      eligibleTrialCount + ineligibleTrialCount === materializedTrialCount
    );
  });

export type BenchmarkExperimentSnapshot = z.infer<typeof benchmarkExperimentSnapshotSchema>;
type ExperimentRequest = z.infer<typeof freezeBenchmarkExperimentRequestSchema>;
type ExperimentScope = {
  admin: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
  signal?: AbortSignal;
};

export class BenchmarkExperimentError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkExperimentError";
  }
}

function experimentRpcError(code: string) {
  switch (code) {
    case "42501":
      return new BenchmarkExperimentError(
        403,
        "Factory manager access is required to freeze an experiment.",
      );
    case "P0002":
    case "PT404":
      return new BenchmarkExperimentError(
        404,
        "The benchmark suite, policy, or factory is unavailable.",
      );
    case "PT409":
      return new BenchmarkExperimentError(
        409,
        "This experiment identity already refers to different inputs.",
      );
    case "P0011":
      return new BenchmarkExperimentError(409, "This factory no longer accepts new experiments.");
    case "PT422":
    case "22023":
      return new BenchmarkExperimentError(
        422,
        "The selected suite, policy, candidates, or scorer revisions cannot form a comparison.",
      );
    default:
      return new Error("The benchmark experiment could not be frozen.");
  }
}

function projectSnapshot(value: unknown, request: ExperimentRequest): BenchmarkExperimentSnapshot {
  const result = benchmarkExperimentSnapshotSchema.safeParse(value);
  if (
    !result.success ||
    result.data.experimentId !== request.experimentId ||
    result.data.suiteRevisionId !== request.suiteRevisionId ||
    result.data.policyRevisionId !== request.policyRevisionId ||
    result.data.repetitions !== request.repetitions ||
    result.data.candidateCount !== request.definitionRevisionIds.length ||
    !matchesBenchmarkEvaluationPlan(result.data.evaluation, request.evaluation)
  ) {
    throw new Error("The frozen benchmark experiment returned an invalid snapshot.");
  }
  return result.data;
}

async function verifyCandidateBatch(scope: ExperimentScope, ids: string[]) {
  const { admin, workspaceId, factoryId, signal } = scope;
  signal?.throwIfAborted();
  const query = admin
    .from("factory_definition_revisions")
    .select("id, definition_json, canonical_digest")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .in("id", ids);
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  signal?.throwIfAborted();
  if (error) throw new Error("The candidate definition revisions could not be read.");
  const revisions = new Map(data.map((row) => [row.id, row]));
  const catalogs = new Map<string, ReturnType<typeof loadFactoryDefinitionCatalog>>();
  return await Promise.all(
    ids.map(async (definitionRevisionId) => {
      const revision = revisions.get(definitionRevisionId);
      if (!revision) {
        throw new BenchmarkExperimentError(
          422,
          "A selected definition revision is unavailable in this factory.",
        );
      }
      const bundle = readVerifiedFactoryDefinition(
        revision.definition_json,
        revision.canonical_digest,
      );
      if (!bundle) {
        throw new BenchmarkExperimentError(
          422,
          "A selected definition revision failed its integrity check.",
        );
      }
      const execution = resolveFactoryExecutionProfile(bundle);
      if (execution.unavailableReason) {
        throw new BenchmarkExperimentError(
          422,
          "A selected definition has an incompatible model, harness, or tool configuration.",
        );
      }
      const selection = factoryComponentRevisionsForBundle(bundle);
      const key = JSON.stringify(selection);
      let catalog = catalogs.get(key);
      if (!catalog) {
        catalog = loadFactoryDefinitionCatalog(admin, { workspaceId, factoryId, ...selection });
        catalogs.set(key, catalog);
      }
      const references = await catalog;
      signal?.throwIfAborted();
      const verified = recompileStoredFactoryDefinition(
        revision.definition_json,
        revision.canonical_digest,
        references,
      );
      if (!verified.ok) {
        throw new BenchmarkExperimentError(
          422,
          "A selected definition no longer resolves to its saved configuration.",
        );
      }
      return {
        definitionRevisionId,
        definitionDigest: verified.canonicalDigest,
        harness: execution.provider,
        model: execution.model,
        sandboxProvider: execution.sandboxProvider,
        workerRuntime: plannedWorkerRuntime,
      };
    }),
  );
}

export async function freezeBenchmarkExperiment(
  scope: ExperimentScope & { actorUserId: string; request: ExperimentRequest },
): Promise<BenchmarkExperimentSnapshot> {
  const { admin, workspaceId, factoryId, actorUserId, signal } = scope;
  signal?.throwIfAborted();
  const parsed = freezeBenchmarkExperimentRequestSchema.safeParse(scope.request);
  if (!parsed.success)
    throw new BenchmarkExperimentError(422, "Provide a valid comparison request.");
  const request = parsed.data;
  const args = {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: actorUserId,
    p_experiment_id: request.experimentId,
    p_suite_revision_id: request.suiteRevisionId,
    p_policy_revision_id: request.policyRevisionId,
    p_repetitions: request.repetitions,
    p_seed: request.seed,
    p_timeout_ms: request.timeoutMs,
  };

  // PostgreSQL checks the actor and normalized request before returning a prior
  // snapshot. A retry does not need the current mutable factory catalog.
  const lookupArgs = {
    ...args,
    p_definition_revision_ids: request.definitionRevisionIds,
    p_worker_runtime: plannedWorkerRuntime,
  };
  const lookup = request.evaluation
    ? admin.rpc("find_factory_benchmark_experiment_retry_with_evaluation", {
        ...lookupArgs,
        p_evaluation_plan: request.evaluation,
      })
    : admin.rpc("find_factory_benchmark_experiment_retry", lookupArgs);
  const prior = await (signal ? lookup.abortSignal(signal) : lookup);
  signal?.throwIfAborted();
  if (prior.error) throw experimentRpcError(prior.error.code);
  if (prior.data !== null) return projectSnapshot(prior.data, request);

  const candidates: Awaited<ReturnType<typeof verifyCandidateBatch>> = [];
  const batchSize = 20;
  for (let index = 0; index < request.definitionRevisionIds.length; index += batchSize) {
    candidates.push(
      ...(await verifyCandidateBatch(
        scope,
        request.definitionRevisionIds.slice(index, index + batchSize),
      )),
    );
  }

  signal?.throwIfAborted();
  const freezeArgs = { ...args, p_candidates: candidates };
  const freeze = request.evaluation
    ? admin.rpc("freeze_factory_benchmark_experiment_with_evaluation", {
        ...freezeArgs,
        p_evaluation_plan: request.evaluation,
      })
    : admin.rpc("freeze_factory_benchmark_experiment", freezeArgs);
  const result = await (signal ? freeze.abortSignal(signal) : freeze);
  signal?.throwIfAborted();
  if (result.error) throw experimentRpcError(result.error.code);
  return projectSnapshot(result.data, request);
}
