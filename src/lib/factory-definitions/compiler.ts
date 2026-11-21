import { agentProviderSupportsEffort, modelMatchesProvider } from "@/lib/agent-config/contracts";
import {
  mcpBindingsFromManifest,
  mcpManifestScopeIds,
  type FactoryMcpBindingSource,
} from "@/lib/factory-mcp/manifest";
import { modelRoutingTargets, type ModelRoutingPolicy } from "@/lib/model-routing/contracts";

import { compileFactoryMcpManifest } from "./mcp-compiler";
import { inspectFactoryPromptReferences } from "./prompt-references";
import {
  normalizeFactoryId,
  resolveFactoryReference,
  supportsFactoryComponent,
  type FactoryDefinitionCatalog,
  type FactoryReferenceEntry,
} from "./references";
import {
  FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
  serialFactoryDefinitionSchema,
  type CompiledFactoryDefinition,
  type SerialFactoryDefinition,
} from "./schema";
import { parseFactoryDefinitionJson, serializeFactoryDefinition } from "./serialization";

export type { CompiledFactoryDefinition } from "./schema";

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
    | "duplicate_repository_binding"
    | "duplicate_stage"
    | "unreachable_stage";
  message: string;
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
    ...(parsed.definition.schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
      ? { scorerRevisionIds: parsed.definition.scorerRevisionIds }
      : {}),
    ...mcpCatalogSelections(parsed.definition.mcpBindings, parsed.definition.executionGrant?.id),
    ...modelRoutingCatalogSelections(parsed.definition.modelRouting),
  };
}

export function factoryComponentRevisionsForBundle(bundle: CompiledFactoryDefinition | null) {
  return {
    agentPromptRevisionId: bundle?.implementationAgent?.promptRevisionId,
    skillRevisionIds: bundle?.skillIds,
    ...(bundle?.schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
      ? { scorerRevisionIds: bundle.scorerRevisionIds }
      : {}),
    ...mcpCatalogSelections(
      bundle?.mcpManifest ? mcpBindingsFromManifest(bundle.mcpManifest) : undefined,
      bundle?.executionGrant?.id,
    ),
    ...modelRoutingCatalogSelections(bundle?.modelRouting),
  };
}

function modelRoutingCatalogSelections(policy: ModelRoutingPolicy | undefined) {
  return policy
    ? {
        modelRoutingConfigurations: modelRoutingTargets(policy).map(
          ({ configuration }) => configuration,
        ),
      }
    : {};
}

function mcpCatalogSelections(
  bindings: readonly FactoryMcpBindingSource[] | undefined,
  grantId: string | undefined,
) {
  if (!bindings?.length) return {};
  return {
    mcpToolRevisionIds: bindings.map(({ toolRevisionId }) => toolRevisionId),
    mcpSecretBindingIds: bindings.flatMap(({ secretBindingId }) =>
      secretBindingId ? [secretBindingId] : [],
    ),
    mcpExecutionGrantId: grantId,
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
  if (definition.modelRouting) {
    for (const { configuration, path } of modelRoutingTargets(definition.modelRouting)) {
      const matches = (catalog.modelRoutingConfigurations ?? []).filter(
        (entry) =>
          entry.workspaceId === catalog.workspaceId &&
          entry.factoryId === catalog.factoryId &&
          entry.experimentId === configuration.experimentId &&
          entry.definitionRevisionId === configuration.definitionRevisionId &&
          entry.qualificationId === configuration.qualificationId &&
          entry.scorerRevisionId === configuration.scorerRevisionId &&
          entry.agentId === configuration.agentId &&
          entry.modelKey === configuration.modelKey &&
          entry.harness === configuration.harness &&
          entry.workerRuntime === configuration.workerRuntime,
      );
      if (matches.length !== 1) {
        diagnostics.push({
          path: ["modelRouting", ...path],
          code: matches.length ? "ambiguous_reference" : "missing_reference",
          message: "Choose one exact qualified benchmark configuration from this factory.",
        });
      }
    }
  }
  if (definition.contextDocuments && !definition.executionGrant) {
    diagnostics.push({
      path: ["contextDocuments"],
      code: "invalid_schema",
      message: "Context documents require an approved service execution grant.",
    });
  }
  if (
    definition.credentialBindingId &&
    (!definition.executionGrant || !definition.implementationAgent)
  ) {
    diagnostics.push({
      path: ["credentialBindingId"],
      code: "invalid_schema",
      message:
        "A credential binding requires a service execution grant and an implementation agent revision.",
    });
  }
  if (
    definition.executionGrant &&
    (!definition.executionPolicy || definition.writableRepositories?.length)
  ) {
    diagnostics.push({
      path: ["executionGrant"],
      code: "invalid_schema",
      message:
        "A service execution grant requires one writable repository and an execution policy revision.",
    });
  }

  function find<T extends FactoryReferenceEntry>(
    entries: readonly T[],
    reference: string,
    path: DefinitionPath,
    missingMessage = `Reference "${reference}" is unavailable in this workspace. Choose an available component.`,
  ): T | null {
    const result = resolveFactoryReference(entries, catalog.workspaceId, reference);
    if (result.ok) return result.entry;
    diagnostics.push({
      path,
      code: result.code,
      message:
        result.code === "ambiguous_reference"
          ? `Reference "${reference}" matches multiple catalog entries. Use a unique stable ID or correct the catalog.`
          : missingMessage,
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
  const seenRepositoryIds = new Set(repository ? [normalizeFactoryId(repository.id)] : []);

  function repositoryIds(kind: "writableRepositories" | "readContextRepositories") {
    const ids: string[] = [];
    definition[kind]?.forEach((reference, index) => {
      const path = [kind, index];
      const entry = find(catalog.repositories, reference, path);
      if (!entry) return;
      const id = normalizeFactoryId(entry.id);
      if (seenRepositoryIds.has(id)) {
        diagnostics.push({
          path,
          code: "duplicate_repository_binding",
          message: `Use "${reference}" only once across the factory's repository bindings.`,
        });
        return;
      }
      seenRepositoryIds.add(id);
      ids.push(id);
    });
    return ids.sort();
  }

  const writableRepositoryIds = repositoryIds("writableRepositories");
  const readContextRepositoryIds = repositoryIds("readContextRepositories");
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

  const selectedSkills = new Set<string>();
  definition.skills.forEach((reference, index) => {
    const path = ["skills", index];
    const entry = find(
      catalog.skills,
      reference,
      path,
      `Skill revision "${reference}" is unavailable in this factory. Choose an active revision.`,
    );
    if (!entry) return;
    if (!supportsFactoryComponent(entry, agent.provider, sandboxProvider)) {
      diagnostics.push({
        path,
        code: "unsupported_capability",
        message: `"${reference}" is unavailable for ${agent.provider} on ${sandboxProvider}.`,
      });
      return;
    }
    selectedSkills.add(normalizeFactoryId(entry.id));
  });

  const skillIds = [...selectedSkills].sort();
  if (schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION) {
    const factoryId = catalog.factoryId && normalizeFactoryId(catalog.factoryId);
    const revisions = (catalog.scorerRevisions ?? []).filter(
      (entry) => normalizeFactoryId(entry.factoryId) === factoryId,
    );
    definition.scorerRevisionIds.forEach((id, index) => {
      find(
        revisions.filter((entry) => normalizeFactoryId(entry.id) === id),
        id,
        ["scorerRevisionIds", index],
        `Scorer revision "${id}" is unavailable in this factory. Choose a revision from this factory.`,
      );
    });
  }
  const mcpManifest = compileFactoryMcpManifest({
    definition,
    catalog,
    agentId: implementationAgent ? normalizeFactoryId(implementationAgent.agentId) : undefined,
    diagnostics,
  });
  const toolIds = mcpManifestScopeIds(mcpManifest?.servers ?? []);
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
    ...(schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
      ? { schemaVersion, scorerRevisionIds: [...definition.scorerRevisionIds].sort() }
      : { schemaVersion }),
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
    ...(writableRepositoryIds.length ? { writableRepositoryIds } : {}),
    ...(readContextRepositoryIds.length ? { readContextRepositoryIds } : {}),
    ...(definition.contextDocuments ? { contextDocuments: definition.contextDocuments } : {}),
    ...(definition.executionGrant ? { executionGrant: definition.executionGrant } : {}),
    ...(definition.credentialBindingId
      ? { credentialBindingId: definition.credentialBindingId }
      : {}),
    ...(definition.modelRouting ? { modelRouting: definition.modelRouting } : {}),
    executionPolicyRevisionId: executionPolicy ? normalizeFactoryId(executionPolicy.id) : null,
    deliveryPolicyRevisionId: deliveryPolicy ? normalizeFactoryId(deliveryPolicy.id) : null,
    skillIds,
    toolIds,
    ...(mcpManifest ? { mcpManifest } : {}),
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
