import { createHash } from "node:crypto";

import { mcpBindingsFromManifest } from "@/lib/factory-mcp/manifest";

import {
  compileFactoryDefinition,
  type CompiledFactoryDefinition,
  type FactoryDefinitionCompileResult,
} from "./compiler";
import type { FactoryDefinitionCatalog } from "./references";
import { compiledFactoryDefinitionSchema, type SerialFactoryDefinition } from "./schema";
import { parseFactoryDefinitionJson } from "./serialization";

/** Check stored semantics against a fresh catalog without accepting changed identities. */
export function recompileStoredFactoryDefinition(
  definitionJson: string,
  canonicalDigest: string,
  catalog: FactoryDefinitionCatalog,
): FactoryDefinitionCompileResult {
  const bundle = readCompiledFactoryDefinition(definitionJson);
  if (!bundle) return incompatibleStoredDefinition();
  const recompiled = compileFactoryDefinition(
    { kind: "structured", value: factoryDefinitionFromBundle(bundle) },
    catalog,
  );
  if (!recompiled.ok) return recompiled;
  if (
    recompiled.definitionJson !== definitionJson ||
    recompiled.canonicalDigest !== canonicalDigest
  ) {
    return incompatibleStoredDefinition();
  }
  return recompiled;
}

export function readCompiledFactoryDefinition(definitionJson: string) {
  const decoded = parseFactoryDefinitionJson(definitionJson);
  const parsed = compiledFactoryDefinitionSchema.safeParse(decoded.ok ? decoded.value : null);
  return parsed.success ? parsed.data : null;
}

export function readVerifiedFactoryDefinition(definitionJson: string, canonicalDigest: string) {
  const digest = createHash("sha256").update(definitionJson, "utf8").digest("hex");
  return digest === canonicalDigest ? readCompiledFactoryDefinition(definitionJson) : null;
}

export function factoryStageDefinition({
  id,
  slug,
  name,
  description,
  promptTemplateMd,
  anyoneCanApprove,
  approverMemberIds,
}: SerialFactoryDefinition["stages"][number]) {
  return { id, slug, name, description, promptTemplateMd, anyoneCanApprove, approverMemberIds };
}

export function factoryDefinitionFromBundle(
  bundle: CompiledFactoryDefinition,
): SerialFactoryDefinition {
  const {
    schemaVersion,
    kind,
    sandboxProvider,
    agent,
    implementationAgent,
    operatingRulesMd,
    pipelineId,
    repositoryId,
    writableRepositoryIds,
    readContextRepositoryIds,
    contextDocuments,
    executionGrant,
    credentialBindingId,
    executionPolicyRevisionId,
    deliveryPolicyRevisionId,
    skillIds,
    mcpManifest,
    stages,
  } = bundle;
  return {
    schemaVersion,
    kind,
    sandboxProvider,
    agent,
    ...(implementationAgent ? { implementationAgent: implementationAgent.promptRevisionId } : {}),
    operatingRulesMd,
    pipeline: pipelineId,
    repository: repositoryId,
    ...(writableRepositoryIds ? { writableRepositories: writableRepositoryIds } : {}),
    ...(readContextRepositoryIds ? { readContextRepositories: readContextRepositoryIds } : {}),
    ...(contextDocuments ? { contextDocuments } : {}),
    ...(executionGrant ? { executionGrant } : {}),
    ...(credentialBindingId ? { credentialBindingId } : {}),
    executionPolicy: executionPolicyRevisionId,
    deliveryPolicy: deliveryPolicyRevisionId,
    skills: skillIds,
    tools: [],
    ...(mcpManifest ? { mcpBindings: mcpBindingsFromManifest(mcpManifest) } : {}),
    stages: stages.map(factoryStageDefinition),
  };
}

function incompatibleStoredDefinition(): FactoryDefinitionCompileResult {
  return {
    ok: false,
    diagnostics: [
      {
        path: [],
        code: "invalid_schema",
        message:
          "This revision is incompatible with the current serial definition format. Save a new draft.",
      },
    ],
  };
}
