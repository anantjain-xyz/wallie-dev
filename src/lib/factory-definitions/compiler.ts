import { agentProviderSupportsEffort, modelMatchesProvider } from "@/lib/agent-config/contracts";
import type { FactoryAgentPromptSnapshot } from "@/lib/factory-agents/contracts";

import { inspectFactoryPromptReferences } from "./prompt-references";
import {
  normalizeFactoryId,
  resolveFactoryReference,
  supportsFactoryComponent,
  type FactoryDefinitionCatalog,
  type FactoryReferenceEntry,
} from "./references";
import { serialFactoryDefinitionSchema, type SerialFactoryDefinition } from "./schema";
import { parseFactoryDefinitionJson, serializeFactoryDefinition } from "./serialization";

export type FactoryDefinitionSource =
  | { kind: "structured"; value: unknown }
  | { kind: "json"; text: string };

type DefinitionPath = readonly (string | number)[];
export type FactoryDefinitionDiagnostic = {
  path: DefinitionPath;
  code:
    | "invalid_json"
    | "invalid_schema"
    | "missing_reference"
    | "ambiguous_reference"
    | "unsupported_capability"
    | "duplicate_stage"
    | "unreachable_stage";
  message: string;
};

export type CompiledFactoryDefinition = Pick<
  SerialFactoryDefinition,
  "schemaVersion" | "kind" | "agent" | "sandboxProvider" | "operatingRulesMd"
> & {
  implementationAgent?: FactoryAgentPromptSnapshot;
  pipelineId: string;
  repositoryId: string;
  executionPolicyRevisionId: string | null;
  deliveryPolicyRevisionId: string | null;
  skillIds: string[];
  toolIds: string[];
  operatingRuleStageIds: string[];
  stages: (SerialFactoryDefinition["stages"][number] & { previousStageIds: string[] })[];
};

export type FactoryDefinitionCompileResult =
  | { ok: false; diagnostics: FactoryDefinitionDiagnostic[] }
  | {
      ok: true;
      bundle: CompiledFactoryDefinition;
      definitionJson: string;
      canonicalDigest: string;
    };

/** Compiles a candidate against a scoped catalog without loading or executing any inputs. */
export function compileFactoryDefinition(
  source: FactoryDefinitionSource,
  catalog: FactoryDefinitionCatalog,
): FactoryDefinitionCompileResult {
  const parsed = readFactoryDefinitionSource(source);
  return parsed.ok ? compileSerialDefinition(parsed.definition, catalog) : parsed;
}

export function factoryComponentRevisionsForSource(source: FactoryDefinitionSource) {
  const parsed = readFactoryDefinitionSource(source);
  if (!parsed.ok) return {};

  return {
    agentPromptRevisionId: parsed.definition.implementationAgent,
    skillRevisionIds: parsed.definition.skills,
  };
}

function readFactoryDefinitionSource(
  source: FactoryDefinitionSource,
):
  | { ok: true; definition: SerialFactoryDefinition }
  | { ok: false; diagnostics: FactoryDefinitionDiagnostic[] } {
  const input =
    source.kind === "json"
      ? parseFactoryDefinitionJson(source.text)
      : { ok: true as const, value: source.value };
  if (!input.ok) {
    return { ok: false, diagnostics: [{ path: [], code: "invalid_json", message: input.message }] };
  }
  const parsed = serialFactoryDefinitionSchema.safeParse(input.value);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.flatMap((issue) =>
        issue.code === "unrecognized_keys"
          ? issue.keys.map((key) => ({
              path: [...issue.path, key],
              code: "invalid_schema",
              message: "Remove this unsupported field.",
            }))
          : [{ path: issue.path, code: "invalid_schema", message: issue.message }],
      ),
    };
  }
  return { ok: true, definition: parsed.data };
}

function compileSerialDefinition(
  definition: SerialFactoryDefinition,
  catalog: FactoryDefinitionCatalog,
): FactoryDefinitionCompileResult {
  const diagnostics: FactoryDefinitionDiagnostic[] = [];
  const { schemaVersion, kind, agent, sandboxProvider, operatingRulesMd } = definition;

  function find<T extends FactoryReferenceEntry>(
    entries: readonly T[],
    reference: string,
    path: DefinitionPath,
  ): T | null {
    const result = resolveFactoryReference(entries, catalog.workspaceId, reference);
    if (result.ok) return result.entry;
    diagnostics.push({
      path,
      code: result.code,
      message:
        result.code === "ambiguous_reference"
          ? `Reference "${reference}" matches multiple catalog entries. Use a unique stable ID or correct the catalog.`
          : path[0] === "skills"
            ? `Skill revision "${reference}" is unavailable in this factory. Choose an active revision.`
            : `Reference "${reference}" is unavailable in this workspace. Choose an available component.`,
    });
    return null;
  }

  const pipeline = find(catalog.pipelines, definition.pipeline, ["pipeline"]);
  const implementationAgent = definition.implementationAgent
    ? find(catalog.agentPromptRevisions ?? [], definition.implementationAgent, [
        "implementationAgent",
      ])
    : null;
  const repository = find(catalog.repositories, definition.repository, ["repository"]);
  const executionPolicy =
    definition.executionPolicy === null
      ? null
      : find(catalog.executionPolicyRevisions, definition.executionPolicy, ["executionPolicy"]);
  const deliveryPolicy =
    definition.deliveryPolicy === null
      ? null
      : find(catalog.deliveryPolicyRevisions, definition.deliveryPolicy, ["deliveryPolicy"]);
  if (
    pipeline &&
    deliveryPolicy &&
    normalizeFactoryId(deliveryPolicy.pipelineId) !== normalizeFactoryId(pipeline.id)
  ) {
    diagnostics.push({
      path: ["deliveryPolicy"],
      code: "unsupported_capability",
      message: "Choose a delivery policy revision for this pipeline.",
    });
  }
  if (!catalog.sandboxProviders.includes(sandboxProvider)) {
    diagnostics.push({
      path: ["sandboxProvider"],
      code: "unsupported_capability",
      message: `Sandbox provider "${sandboxProvider}" is unavailable for this factory.`,
    });
  }
  if (!modelMatchesProvider(agent.provider, agent.model)) {
    diagnostics.push({
      path: ["agent", "model"],
      code: "unsupported_capability",
      message: `Choose a model supported by "${agent.provider}".`,
    });
  }
  if (agent.effort !== null && !agentProviderSupportsEffort(agent.provider)) {
    diagnostics.push({
      path: ["agent", "effort"],
      code: "unsupported_capability",
      message: `Remove effort for "${agent.provider}". This agent uses its own defaults.`,
    });
  }

  function componentIds(kind: "skills" | "tools"): string[] {
    const ids = new Set<string>();
    definition[kind].forEach((reference, index) => {
      const path = [kind, index];
      const entry = find(catalog[kind], reference, path);
      if (!entry) return;
      if (!supportsFactoryComponent(entry, agent.provider, sandboxProvider)) {
        diagnostics.push({
          path,
          code: "unsupported_capability",
          message: `"${reference}" is unavailable for ${agent.provider} on ${sandboxProvider}.`,
        });
        return;
      }
      ids.add(normalizeFactoryId(entry.id));
    });
    return [...ids].sort();
  }

  const skillIds = componentIds("skills");
  const toolIds = componentIds("tools");
  const duplicates = duplicateStageDiagnostics(definition.stages);
  diagnostics.push(...duplicates);

  function promptStageIds(template: string, path: DefinitionPath, stageIndex?: number): string[] {
    if (duplicates.length) return [];
    const result = inspectFactoryPromptReferences(template, definition.stages, stageIndex);
    diagnostics.push(...result.errors.map(({ code, message }) => ({ path, code, message })));
    return result.stageIds;
  }

  const operatingRuleStageIds = promptStageIds(operatingRulesMd, ["operatingRulesMd"]);
  const stages = definition.stages.map((stage, index) => {
    const approverMemberIds = new Set<string>();
    stage.approverMemberIds.forEach((id, approverIndex) => {
      const member = find(catalog.approvers, id, [
        "stages",
        index,
        "approverMemberIds",
        approverIndex,
      ]);
      if (member) approverMemberIds.add(normalizeFactoryId(member.id));
    });
    return {
      ...stage,
      approverMemberIds: [...approverMemberIds].sort(),
      previousStageIds: promptStageIds(
        stage.promptTemplateMd,
        ["stages", index, "promptTemplateMd"],
        index,
      ),
    };
  });

  if (diagnostics.length || !pipeline || !repository) return { ok: false, diagnostics };
  const bundle: CompiledFactoryDefinition = {
    schemaVersion,
    kind,
    agent,
    ...(implementationAgent
      ? {
          implementationAgent: {
            agentId: normalizeFactoryId(implementationAgent.agentId),
            promptRevisionId: normalizeFactoryId(implementationAgent.promptRevisionId),
            promptMd: implementationAgent.promptMd,
            promptSha256: implementationAgent.promptSha256,
          },
        }
      : {}),
    sandboxProvider,
    pipelineId: normalizeFactoryId(pipeline.id),
    repositoryId: normalizeFactoryId(repository.id),
    executionPolicyRevisionId: executionPolicy ? normalizeFactoryId(executionPolicy.id) : null,
    deliveryPolicyRevisionId: deliveryPolicy ? normalizeFactoryId(deliveryPolicy.id) : null,
    skillIds,
    toolIds,
    operatingRulesMd,
    operatingRuleStageIds,
    stages,
  };
  return { ok: true, bundle, ...serializeFactoryDefinition(bundle) };
}

function duplicateStageDiagnostics(
  stages: SerialFactoryDefinition["stages"],
): FactoryDefinitionDiagnostic[] {
  const diagnostics: FactoryDefinitionDiagnostic[] = [];
  for (const field of ["id", "slug"] as const) {
    const seen = new Set<string>();
    stages.forEach((stage, index) => {
      const value = stage[field];
      if (seen.has(value)) {
        diagnostics.push({
          path: ["stages", index, field],
          code: "duplicate_stage",
          message: `Keep each stage ${field} unique. "${value}" is already used.`,
        });
      }
      seen.add(value);
    });
  }
  return diagnostics;
}
