import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadFactoryDefinitionCatalog } from "@/lib/factory-definitions/authority";
import {
  compileFactoryDefinition,
  factoryComponentRevisionsForSource,
  type CompiledFactoryDefinition,
  type FactoryDefinitionDiagnostic,
} from "@/lib/factory-definitions/compiler";
import {
  FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
  type SerialFactoryDefinition,
} from "@/lib/factory-definitions/schema";
import { compareFactoryDefinitions } from "@/lib/factory-definitions/semantic-diff";
import {
  factoryDefinitionFromBundle,
  readVerifiedFactoryDefinition,
} from "@/lib/factory-definitions/stored-definition";
import { modelRoutingTargets } from "@/lib/model-routing/contracts";
import type { Database } from "@/lib/supabase/database.types";

import type { FactoryProposalEdit, FactoryProposalGrant } from "./contracts";

function invalid(path: FactoryDefinitionDiagnostic["path"], message: string) {
  return {
    ok: false as const,
    diagnostics: [{ path, code: "unsupported_capability" as const, message }],
  };
}

function replaceBoundRevision(original: string[], selected: string[], from: string, to: string) {
  if (
    !original.includes(from) ||
    original.includes(to) ||
    !selected.includes(from) ||
    selected.includes(to)
  ) {
    return null;
  }
  return selected.map((id) => (id === from ? to : id));
}

export function applyFactoryProposalEdits(
  base: CompiledFactoryDefinition,
  grant: FactoryProposalGrant,
  edits: FactoryProposalEdit[],
) {
  const value = factoryDefinitionFromBundle(base);
  for (const [index, edit] of edits.entries()) {
    const error = (message: string) => invalid(["edits", index], message);
    switch (edit.kind) {
      case "stage_prompt": {
        const stage = value.stages.find(({ id }) => id === edit.stageId);
        if (!stage || !grant.stageIds.includes(stage.id))
          return error("Choose a stage supported by the cited diagnosis evidence.");
        const digest = createHash("sha256").update(stage.promptTemplateMd).digest("hex");
        if (
          digest !== edit.expectedPromptSha256 ||
          stage.promptTemplateMd === edit.promptTemplateMd
        ) {
          return error("Change the exact prompt from the selected base definition.");
        }
        stage.promptTemplateMd = edit.promptTemplateMd;
        break;
      }
      case "agent_prompt": {
        if (
          base.implementationAgent?.agentId !== edit.agentId ||
          !grant.agentIds.includes(edit.agentId) ||
          base.implementationAgent.promptRevisionId !== edit.fromRevisionId ||
          edit.fromRevisionId === edit.toRevisionId
        ) {
          return error("Choose a new prompt revision for the cited agent pinned to the base.");
        }
        value.implementationAgent = edit.toRevisionId;
        break;
      }
      case "skill_revision": {
        const skills = replaceBoundRevision(
          base.skillIds,
          value.skills,
          edit.fromRevisionId,
          edit.toRevisionId,
        );
        if (!skills || !grant.skillRevisionIds.includes(edit.fromRevisionId)) {
          return error(
            "Replace a skill revision that the cited run used and the base still binds.",
          );
        }
        value.skills = skills;
        break;
      }
      case "scorer_revision": {
        if (
          base.schemaVersion !== FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION ||
          value.schemaVersion !== FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
        ) {
          return error("The base definition must support pinned scorer revisions.");
        }
        const scorers = replaceBoundRevision(
          base.scorerRevisionIds,
          value.scorerRevisionIds,
          edit.fromRevisionId,
          edit.toRevisionId,
        );
        if (!scorers || !grant.scorerRevisionIds.includes(edit.fromRevisionId)) {
          return error("Replace a scorer revision cited in the diagnosis and bound to the base.");
        }
        value.scorerRevisionIds = scorers;
        break;
      }
      case "workflow_order": {
        const stages = new Map(value.stages.map((stage) => [stage.id, stage]));
        const reordered = edit.toStageIds.flatMap((id) => {
          const stage = stages.get(id);
          return stage ? [stage] : [];
        });
        if (
          !isDeepStrictEqual(
            edit.fromStageIds,
            base.stages.map(({ id }) => id),
          ) ||
          reordered.length !== stages.size ||
          reordered.length !== edit.toStageIds.length ||
          new Set(edit.toStageIds).size !== stages.size ||
          isDeepStrictEqual(edit.fromStageIds, edit.toStageIds)
        ) {
          return error("Reorder the same stable stages from the selected base.");
        }
        if (
          edit.toStageIds.some(
            (id, position) => edit.fromStageIds[position] !== id && !grant.stageIds.includes(id),
          )
        ) {
          return error("Each stage that moves must be supported by the cited diagnosis evidence.");
        }
        value.stages = reordered;
        break;
      }
      case "routing_target": {
        const policy = value.modelRouting;
        const rule = policy?.rules.find(({ id }) => id === edit.ruleId);
        if (
          !policy ||
          !rule ||
          !grant.routingRuleIds.includes(rule.id) ||
          !isDeepStrictEqual(rule.configuration, edit.from) ||
          isDeepStrictEqual(edit.from, edit.to) ||
          edit.from.agentId !== edit.to.agentId
        ) {
          return error(
            "Change the exact primary configuration of a cited routing rule for the same agent.",
          );
        }
        value.modelRouting = {
          ...policy,
          rules: policy.rules.map((item) =>
            item.id === rule.id ? { ...item, configuration: edit.to } : item,
          ),
        };
        break;
      }
    }
  }
  return { ok: true as const, source: { kind: "structured" as const, value } };
}

function normalizedSelections(source: SerialFactoryDefinition) {
  return {
    ...source,
    skills: [...source.skills].sort(),
    ...(source.schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
      ? { scorerRevisionIds: [...source.scorerRevisionIds].sort() }
      : {}),
  };
}

function routingScope(definition: CompiledFactoryDefinition) {
  const {
    repositoryId,
    pipelineId,
    sandboxProvider,
    executionGrant,
    credentialBindingId,
    executionPolicyRevisionId,
    deliveryPolicyRevisionId,
    writableRepositoryIds,
    readContextRepositoryIds,
    contextDocuments,
    toolIds,
    skillIds,
    mcpManifest,
  } = definition;
  return {
    repositoryId,
    pipelineId,
    sandboxProvider,
    executionGrant,
    credentialBindingId,
    executionPolicyRevisionId,
    deliveryPolicyRevisionId,
    writableRepositoryIds,
    readContextRepositoryIds,
    contextDocuments,
    toolIds,
    skillIds,
    mcpManifest,
  };
}

export async function compileFactoryProposal({
  client,
  workspaceId,
  factoryId,
  base,
  grant,
  edits,
}: {
  client: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
  base: CompiledFactoryDefinition;
  grant: FactoryProposalGrant;
  edits: FactoryProposalEdit[];
}) {
  const patched = applyFactoryProposalEdits(base, grant, edits);
  if (!patched.ok) return patched;
  const { source } = patched;
  const skills = edits.filter((edit) => edit.kind === "skill_revision");
  const scorers = edits.filter((edit) => edit.kind === "scorer_revision");
  const routes = edits.filter((edit) => edit.kind === "routing_target");
  const ids = (items: typeof skills | typeof scorers) => [
    ...new Set(items.flatMap(({ fromRevisionId, toRevisionId }) => [fromRevisionId, toRevisionId])),
  ];
  const [catalog, skillRows, scorerRows] = await Promise.all([
    loadFactoryDefinitionCatalog(client, {
      workspaceId,
      factoryId,
      ...factoryComponentRevisionsForSource(source),
    }),
    skills.length
      ? client
          .from("factory_skill_revisions")
          .select("id,skill_id,revoked_at")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", ids(skills))
      : null,
    scorers.length
      ? client
          .from("factory_scorer_revisions")
          .select("id,scorer_id")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", ids(scorers))
      : null,
  ]);
  if (skillRows?.error) throw skillRows.error;
  if (scorerRows?.error) throw scorerRows.error;
  const skillRevisions = new Map(skillRows?.data.map((revision) => [revision.id, revision]));
  const scorerFamilies = new Map(scorerRows?.data.map(({ id, scorer_id }) => [id, scorer_id]));
  if (
    skills.some(
      ({ skillId, fromRevisionId, toRevisionId }) =>
        skillRevisions.get(fromRevisionId)?.skill_id !== skillId ||
        skillRevisions.get(toRevisionId)?.skill_id !== skillId ||
        skillRevisions.get(toRevisionId)?.revoked_at !== null,
    )
  ) {
    return invalid(["skills"], "Choose available revisions from the same cited skill.");
  }
  if (
    scorers.some(
      ({ scorerId, fromRevisionId, toRevisionId }) =>
        scorerFamilies.get(fromRevisionId) !== scorerId ||
        scorerFamilies.get(toRevisionId) !== scorerId,
    )
  ) {
    return invalid(["scorerRevisionIds"], "Choose revisions from the same cited scorer.");
  }

  const compiled = compileFactoryDefinition(source, catalog);
  if (!compiled.ok) return compiled;
  const { bundle, definitionJson, canonicalDigest } = compiled;
  const editedStagePrompts = new Set(
    edits.flatMap((edit) => (edit.kind === "stage_prompt" ? [edit.stageId] : [])),
  );
  const baseStages = new Map(base.stages.map((stage) => [stage.id, stage]));
  const agentEdited = edits.some(({ kind }) => kind === "agent_prompt");
  if (
    !isDeepStrictEqual(
      normalizedSelections(source.value),
      normalizedSelections(factoryDefinitionFromBundle(bundle)),
    ) ||
    !isDeepStrictEqual(base.mcpManifest, bundle.mcpManifest) ||
    !isDeepStrictEqual(base.toolIds, bundle.toolIds) ||
    !isDeepStrictEqual(base.operatingRuleStageIds, bundle.operatingRuleStageIds) ||
    bundle.implementationAgent?.agentId !== base.implementationAgent?.agentId ||
    (!agentEdited && !isDeepStrictEqual(base.implementationAgent, bundle.implementationAgent)) ||
    bundle.stages.some(
      (stage) =>
        !editedStagePrompts.has(stage.id) &&
        !isDeepStrictEqual(stage.previousStageIds, baseStages.get(stage.id)?.previousStageIds),
    )
  ) {
    return invalid([], "The compiled candidate changes definition fields outside the typed patch.");
  }

  if (bundle.modelRouting && (routes.length || skills.length)) {
    const configurations = skills.length
      ? modelRoutingTargets(bundle.modelRouting).map(({ configuration }) => configuration)
      : routes.map(({ to }) => to);
    const targetIds = [
      ...new Set(configurations.map(({ definitionRevisionId }) => definitionRevisionId)),
    ];
    const targets = new Map<string, CompiledFactoryDefinition>();
    for (let index = 0; index < targetIds.length; index += 50) {
      const { data, error } = await client
        .from("factory_definition_revisions")
        .select("id,canonical_digest,definition_json")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .in("id", targetIds.slice(index, index + 50));
      if (error) throw error;
      for (const row of data) {
        const target = readVerifiedFactoryDefinition(row.definition_json, row.canonical_digest);
        if (target) targets.set(row.id, target);
      }
    }
    const scope = routingScope(bundle);
    if (
      configurations.some((configuration) => {
        const target = targets.get(configuration.definitionRevisionId);
        return (
          !target ||
          !isDeepStrictEqual(scope, routingScope(target)) ||
          (bundle.executionGrant &&
            configuration.agentId !== bundle.implementationAgent?.agentId) ||
          (bundle.mcpManifest?.servers.length && configuration.harness !== bundle.agent.provider)
        );
      })
    ) {
      return invalid(
        ["modelRouting"],
        "Use qualified routing targets that preserve the candidate’s execution scope.",
      );
    }
  }

  return {
    ok: true as const,
    definitionJson,
    canonicalDigest,
    diff: compareFactoryDefinitions(base, bundle),
  };
}
