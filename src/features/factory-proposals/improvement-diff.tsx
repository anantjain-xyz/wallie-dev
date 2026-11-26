import "server-only";

import { isDeepStrictEqual } from "node:util";

import { FactorySemanticDiffComparison } from "@/features/factory-definition/semantic-diff";
import type {
  FactoryDiffValue,
  FactoryFieldDifference,
} from "@/lib/factory-definitions/semantic-diff";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import type { ImprovementWorkbench } from "@/lib/factory-proposals/workbench";
import {
  modelRoutingPolicySchema,
  type ModelRoutingConfiguration,
} from "@/lib/model-routing/contracts";

import type { loadImprovementScope } from "./improvement-scope";

const promptField = "Agent prompt revision";
const skillField = "Skills";
const scorerField = "Scorers";
const routingField = "Model routing policy";
const stageField = "Previous stage references";
const exactFields = new Set([promptField, skillField, scorerField, routingField, stageField]);
const savedDate = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function readIds(value: FactoryDiffValue) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    const parsed = factoryProposalUuidSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function routingPolicy(value: FactoryDiffValue) {
  if (typeof value !== "string") return null;
  try {
    return modelRoutingPolicySchema.safeParse(JSON.parse(value)).data ?? null;
  } catch {
    return null;
  }
}

export async function ImprovementDiff({
  proposal,
  scope,
}: {
  proposal: Extract<ImprovementWorkbench["proposal"], { status: "compiled" }>;
  scope: NonNullable<Awaited<ReturnType<typeof loadImprovementScope>>>;
}) {
  const { supabase, workspaceId, factoryId } = scope;
  const diff = proposal.diff;
  const comparisonLabels = {
    beforeLabel: proposal.baseCurrent ? "Active configuration" : "Recorded base",
    afterLabel: "Proposed configuration",
  };
  const exact = {
    fields: diff.fields.filter(({ label }) => exactFields.has(label)),
    stages: diff.stages.flatMap((stage) => {
      const fields = stage.fields.filter(({ label }) => exactFields.has(label));
      return fields.length ? [{ ...stage, fields }] : [];
    }),
  };
  const fieldIds = (label: string) => {
    const field = exact.fields.find((entry) => entry.label === label);
    return field ? [...new Set([...readIds(field.before), ...readIds(field.after)])] : [];
  };
  const promptIds = fieldIds(promptField);
  const skillIds = fieldIds(skillField);
  const scorerIds = fieldIds(scorerField);

  const routingChange = exact.fields.find(({ label }) => label === routingField);
  const beforePolicy = routingPolicy(routingChange?.before ?? null);
  const afterPolicy = routingPolicy(routingChange?.after ?? null);
  const priorRules = new Map(beforePolicy?.rules.map((rule) => [rule.id, rule]));
  const nextRules = new Map(afterPolicy?.rules.map((rule) => [rule.id, rule]));
  const changedRules = new Set(
    [...priorRules.keys(), ...nextRules.keys()].filter(
      (id) => !isDeepStrictEqual(priorRules.get(id), nextRules.get(id)),
    ),
  );
  const targets = [...priorRules.values(), ...nextRules.values()]
    .filter(({ id }) => changedRules.has(id))
    .flatMap(({ configuration, onUnavailable }) =>
      onUnavailable.kind === "fallback"
        ? [configuration, onUnavailable.configuration]
        : [configuration],
    );
  const routingAgentIds = [...new Set(targets.map(({ agentId }) => agentId))];
  const definitionIds = [
    ...new Set([
      ...targets.map(({ definitionRevisionId }) => definitionRevisionId),
      ...(exact.stages.length ? [proposal.base.revisionId] : []),
    ]),
  ];

  const [prompts, skills, scorers, agents, definitions] = await Promise.all([
    promptIds.length
      ? supabase
          .from("factory_agent_prompt_revisions")
          .select("id, revision_number, factory_agents!inner(name)")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", promptIds)
      : null,
    skillIds.length
      ? supabase
          .from("factory_skill_revisions")
          .select("id, revision_number, factory_skills!inner(name)")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", skillIds)
      : null,
    scorerIds.length
      ? supabase
          .from("factory_scorer_revisions")
          .select("id, revision_number, factory_scorers!inner(name)")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", scorerIds)
      : null,
    routingAgentIds.length
      ? supabase
          .from("factory_agents")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", routingAgentIds)
      : null,
    definitionIds.length
      ? supabase
          .from("factory_definition_revisions")
          .select("id, definition_json, canonical_digest, created_at")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", definitionIds)
      : null,
  ]);
  const names = new Map([
    ...(prompts?.data ?? []).map(
      (row) => [row.id, `${row.factory_agents.name} · Prompt v${row.revision_number}`] as const,
    ),
    ...(skills?.data ?? []).map(
      (row) => [row.id, `${row.factory_skills.name} · Revision ${row.revision_number}`] as const,
    ),
    ...(scorers?.data ?? []).map(
      (row) => [row.id, `${row.factory_scorers.name} · Revision ${row.revision_number}`] as const,
    ),
  ]);
  const agentNames = new Map(agents?.data?.map((row) => [row.id, row.name]));
  const definitionsById = new Map(definitions?.data?.map((row) => [row.id, row]));
  const stageNames = (json: string | undefined, digest: string) => {
    const definition = json ? readVerifiedFactoryDefinition(json, digest) : null;
    return new Map(definition?.stages.map(({ id, name, slug }) => [id, `${name} (${slug})`]));
  };
  const beforeStages = stageNames(
    definitionsById.get(proposal.base.revisionId)?.definition_json,
    proposal.base.digest,
  );
  const afterStages = stageNames(proposal.candidate.definitionJson, proposal.candidate.digest);

  function namedValue(value: FactoryDiffValue, lookup: Map<string, string>, fallback: string) {
    const label = (id: string) => lookup.get(id) ?? fallback;
    if (typeof value === "string") return label(value);
    return Array.isArray(value) ? [...new Set(value.map(label))] : value;
  }

  function routingTargetLabel(configuration: ModelRoutingConfiguration) {
    const target = definitionsById.get(configuration.definitionRevisionId);
    return [
      configuration.modelKey,
      configuration.harness,
      agentNames.get(configuration.agentId) ?? "Agent name unavailable",
      target
        ? `Definition revision saved ${savedDate.format(new Date(target.created_at))} UTC`
        : "Definition revision unavailable",
    ].join(" · ");
  }

  function routingLabels(policy: ReturnType<typeof routingPolicy>, value: FactoryDiffValue) {
    if (value === null) return null;
    if (!policy || !changedRules.size) return "See exact routing policy in technical details.";
    return policy.rules
      .filter(({ id }) => changedRules.has(id))
      .map(({ taskClassId, configuration, onUnavailable }) => {
        const taskClass = policy.taskClasses.find(({ id }) => id === taskClassId);
        return [
          taskClass?.name ?? "Task class unavailable",
          routingTargetLabel(configuration),
          onUnavailable.kind === "fallback"
            ? `Fallback: ${routingTargetLabel(onUnavailable.configuration)}`
            : "Escalate if unavailable",
        ].join(" · ");
      });
  }

  function readableField(field: FactoryFieldDifference): FactoryFieldDifference {
    if (field.label === routingField) {
      return {
        label: field.label,
        before: routingLabels(beforePolicy, field.before),
        after: routingLabels(afterPolicy, field.after),
      };
    }
    if (!exactFields.has(field.label)) return field;
    const stage = field.label === stageField;
    const fallback = stage ? "Stage name unavailable" : "Revision unavailable";
    return {
      ...field,
      before: namedValue(field.before, stage ? beforeStages : names, fallback),
      after: namedValue(field.after, stage ? afterStages : names, fallback),
    };
  }

  return (
    <>
      <FactorySemanticDiffComparison
        comparison={{
          fields: diff.fields.map(readableField),
          stages: diff.stages.map((stage) => ({
            ...stage,
            fields: stage.fields.map(readableField),
          })),
        }}
        {...comparisonLabels}
      />
      {exact.fields.length || exact.stages.length ? (
        <details className="type-secondary space-y-2">
          <summary className="w-fit cursor-pointer text-muted">
            Technical details: exact diff references
          </summary>
          <FactorySemanticDiffComparison comparison={exact} {...comparisonLabels} />
        </details>
      ) : null}
    </>
  );
}
