import { compileFactoryDefinition, type FactoryDefinitionCompileResult } from "./compiler";
import type { FactoryDefinitionCatalog } from "./references";
import { compiledFactoryDefinitionSchema } from "./schema";
import { parseFactoryDefinitionJson } from "./serialization";

/** Check stored semantics against a fresh catalog without accepting changed identities. */
export function recompileStoredFactoryDefinition(
  definitionJson: string,
  canonicalDigest: string,
  catalog: FactoryDefinitionCatalog,
): FactoryDefinitionCompileResult {
  const decoded = parseFactoryDefinitionJson(definitionJson);
  const parsed = compiledFactoryDefinitionSchema.safeParse(decoded.ok ? decoded.value : null);
  if (!parsed.success) return incompatibleStoredDefinition();

  const {
    schemaVersion,
    kind,
    sandboxProvider,
    agent,
    operatingRulesMd,
    pipelineId,
    repositoryId,
    executionPolicyRevisionId,
    deliveryPolicyRevisionId,
    skillIds,
    toolIds,
    stages,
  } = parsed.data;
  const recompiled = compileFactoryDefinition(
    {
      kind: "structured",
      value: {
        schemaVersion,
        kind,
        sandboxProvider,
        agent,
        operatingRulesMd,
        pipeline: pipelineId,
        repository: repositoryId,
        executionPolicy: executionPolicyRevisionId,
        deliveryPolicy: deliveryPolicyRevisionId,
        skills: skillIds,
        tools: toolIds,
        stages: stages.map(
          ({
            id,
            slug,
            name,
            description,
            promptTemplateMd,
            anyoneCanApprove,
            approverMemberIds,
          }) => ({
            id,
            slug,
            name,
            description,
            promptTemplateMd,
            anyoneCanApprove,
            approverMemberIds,
          }),
        ),
      },
    },
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
