import "server-only";

import { randomUUID } from "node:crypto";

import type { BenchmarkComparisonScope } from "@/lib/factory-benchmarks/comparison";
import { loadFactoryEditorSnapshot } from "@/lib/factory-definitions/editor";
import { mutateFactoryDefinition, mutationError } from "@/lib/factory-definitions/mutations";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import { latestFactoryDraft } from "@/lib/factory-definitions/settings-persistence";
import {
  selectCurrentFactoryActivation,
  selectStoredFactoryDefinition,
} from "@/lib/factory-definitions/storage";
import {
  factoryDefinitionFromBundle,
  readVerifiedFactoryDefinition,
} from "@/lib/factory-definitions/stored-definition";

import { modelRoutingConfigurationSchema } from "./contracts";
import type { RoutingDraftRequest } from "./draft-contracts";

async function readRoutingRequestDraft(
  scope: BenchmarkComparisonScope,
  requestId: string,
  requestDigest: string,
) {
  const { admin, workspaceId, factoryId, actorUserId } = scope;
  const prior = await admin
    .from("factory_routing_draft_evidence")
    .select("draft_id,created_by,request_digest")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("request_id", requestId)
    .maybeSingle();
  if (prior.error) throw prior.error;
  if (!prior.data) return null;
  if (prior.data.created_by !== actorUserId || prior.data.request_digest !== requestDigest) {
    return mutationError({ code: "PT409", message: "This routing request ID was already used." });
  }
  const draft = await selectStoredFactoryDefinition(admin, workspaceId, factoryId, {
    kind: "draft",
    id: prior.data.draft_id,
  });
  if (draft.error || !draft.data) return mutationError(draft.error ?? { code: "P0002" });
  return {
    ok: true as const,
    draftId: draft.data.id,
    canonicalDigest: draft.data.canonical_digest,
  };
}

export async function createRoutingDraft(
  scope: BenchmarkComparisonScope,
  request: RoutingDraftRequest,
) {
  const { admin, workspaceId, factoryId, actorUserId, experimentId } = scope;
  const { canonicalDigest: requestDigest } = serializeFactoryDefinition({ experimentId, request });
  const prior = await readRoutingRequestDraft(scope, request.requestId, requestDigest);
  if (prior) return prior;

  const [activation, selected] = await Promise.all([
    selectCurrentFactoryActivation(admin, workspaceId, factoryId),
    admin
      .from("factory_benchmark_experiment_candidates")
      .select(
        "definition_revision_id,definition_digest,qualification_id,canonical_model_key,harness,worker_runtime",
      )
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("experiment_id", experimentId)
      .eq("candidate_key", request.candidateKey)
      .maybeSingle(),
  ]);
  if (activation.error || selected.error) throw activation.error ?? selected.error;
  if (!selected.data) return mutationError({ code: "P0002" });
  const candidate = selected.data;
  const expectedActivationNumber = activation.data?.activation_number ?? 0;
  const [current, candidateDefinition] = await Promise.all([
    latestFactoryDraft(admin, workspaceId, factoryId, expectedActivationNumber),
    selectStoredFactoryDefinition(admin, workspaceId, factoryId, {
      kind: "revision",
      id: candidate.definition_revision_id,
    }),
  ]);
  if (current.error || candidateDefinition.error) throw current.error ?? candidateDefinition.error;
  const candidateBundle =
    candidateDefinition.data &&
    readVerifiedFactoryDefinition(
      candidateDefinition.data.definition_json,
      candidate.definition_digest,
    );
  const configuration = modelRoutingConfigurationSchema.safeParse({
    agentId: candidateBundle?.implementationAgent?.agentId,
    definitionRevisionId: candidate.definition_revision_id,
    experimentId,
    qualificationId: candidate.qualification_id,
    scorerRevisionId: request.scorerRevisionId,
    modelKey: candidate.canonical_model_key,
    harness: candidate.harness,
    workerRuntime: candidate.worker_runtime,
  });
  if (!configuration.success) {
    return mutationError({
      code: "PT422",
      message: "This candidate has no exact benchmark qualification.",
    });
  }

  const active =
    !current.data && activation.data
      ? await selectStoredFactoryDefinition(admin, workspaceId, factoryId, {
          kind: "revision",
          id: activation.data.revision_id,
        })
      : null;
  if (active?.error) throw active.error;
  const stored = current.data ?? active?.data;
  const verified =
    stored && readVerifiedFactoryDefinition(stored.definition_json, stored.canonical_digest);
  const source = verified
    ? factoryDefinitionFromBundle(verified)
    : !current.data && !activation.data
      ? (await loadFactoryEditorSnapshot(admin, workspaceId, factoryId))?.baseline?.source
      : null;
  if (!source) {
    return mutationError({
      code: "PT422",
      message: "A valid factory definition is required for a routing draft.",
    });
  }

  const policy = source.modelRouting;
  const taskClasses = policy?.taskClasses ?? [];
  const taskClass = taskClasses.find(({ slug }) => slug === request.taskClass.slug);
  if (taskClass && taskClass.name !== request.taskClass.name) {
    return mutationError({
      code: "PT409",
      message: "This task class slug already uses a different name.",
    });
  }
  const taskClassId = taskClass?.id ?? randomUUID();
  const priorRule = policy?.rules.find((rule) => rule.taskClassId === taskClassId);
  const rule = {
    id: priorRule?.id ?? randomUUID(),
    taskClassId,
    configuration: configuration.data,
    constraints: request.constraints,
    onUnavailable: priorRule?.onUnavailable ?? { kind: "escalate" },
  };
  const rules = policy?.rules ?? [];
  const result = await mutateFactoryDefinition({
    admin,
    workspaceId,
    factoryId,
    actorUserId,
    command: {
      action: "draft",
      expectedActivationNumber,
      expectedDraftId: current.data?.id ?? null,
      source: {
        kind: "structured",
        value: {
          ...source,
          modelRouting: {
            version: 1,
            taskClasses: taskClass
              ? taskClasses
              : [...taskClasses, { id: taskClassId, ...request.taskClass }],
            rules: priorRule
              ? rules.map((entry) => (entry.id === rule.id ? rule : entry))
              : [...rules, rule],
            onUnmatched: policy?.onUnmatched ?? { kind: "escalate" },
          },
        },
      },
    },
    routingDraft: {
      p_experiment_id: experimentId,
      p_candidate_key: request.candidateKey,
      p_suite_revision_id: request.suiteRevisionId,
      p_scorer_revision_id: request.scorerRevisionId,
      p_rule_id: rule.id,
      p_request_id: request.requestId,
      p_request_digest: requestDigest,
    },
  });
  if (!result.ok) {
    return result.status === 409
      ? ((await readRoutingRequestDraft(scope, request.requestId, requestDigest)) ?? result)
      : result;
  }
  if (!("draft" in result.result))
    throw new Error("The routing draft did not return a saved draft.");
  return {
    ok: true as const,
    draftId: result.result.draft.id,
    canonicalDigest: result.result.draft.canonicalDigest,
  };
}
