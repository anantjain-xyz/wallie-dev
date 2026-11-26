import type { SerialFactoryDefinition } from "@/lib/factory-definitions/schema";

const topFields = {
  pipeline: "Pipeline",
  implementationAgent: "Implementation agent prompt revision",
  executionPolicy: "Execution policy revision",
  deliveryPolicy: "Delivery policy revision",
  executionGrant: "Execution grant",
  skills: "Skill revisions",
  scorerRevisionIds: "Scorer revisions",
  sandboxProvider: "Sandbox provider",
  operatingRulesMd: "Operating rules",
  stages: "Workflow stages",
  modelRouting: "Model routing",
} as const;

const stageFields = {
  name: "Stage name",
  slug: "Stage slug",
  description: "Description",
  promptTemplateMd: "Stage prompt",
  anyoneCanApprove: "Approval policy",
  approverMemberIds: "Approvers",
} as const;

const agentFields = {
  provider: "Agent provider",
  model: "Model",
  effort: "Reasoning effort",
  concurrencyLimit: "Concurrency limit",
  stallTimeoutMs: "Stall timeout",
  maxRetries: "Maximum retries",
  maxTurns: "Maximum turns",
} as const;

const toolFields = {
  toolRevisionId: "Tool revision",
  operations: "Allowed operations",
  secretBindingId: "MCP secret binding",
} as const;

function hasKey<T extends object>(object: T, key: unknown): key is keyof T {
  return typeof key === "string" && Object.hasOwn(object, key);
}

export function validationField(
  path: readonly (string | number)[],
  source?: SerialFactoryDefinition,
) {
  const [field, index, child] = path;
  if (!source) return { label: "Definition JSON", id: "definition-json" };
  if (
    field === "stages" &&
    typeof index === "number" &&
    hasKey(stageFields, child) &&
    source.stages[index]
  ) {
    const stage = source.stages[index];
    return {
      label: `${stage.name.trim() || `Stage ${index + 1}`} · ${stageFields[child]}`,
      id: `definition-field-stages-${index}-${child === "approverMemberIds" && stage.anyoneCanApprove ? "anyoneCanApprove" : child}`,
    };
  }
  if (field === "agent" && hasKey(agentFields, index)) {
    return { label: agentFields[index], id: `definition-field-agent-${index}` };
  }
  if (field === "mcpBindings" && typeof index === "number" && hasKey(toolFields, child)) {
    return {
      label: `Tool binding ${index + 1} · ${toolFields[child]}`,
      id: `definition-field-mcpBindings-${index}-${child}`,
      fallback: "definition-field-mcpBindings",
    };
  }
  if (field === "contextDocuments")
    return { label: "External context documents", id: "definition-context-documents" };
  if (
    field === "repository" ||
    field === "writableRepositories" ||
    field === "readContextRepositories"
  ) {
    return { label: "Repository bindings", id: "definition-field-repositories" };
  }
  if (field === "tools" || field === "mcpBindings")
    return { label: "Tool bindings", id: "definition-field-mcpBindings" };
  if (field === "credentialBindingId")
    return { label: "Service credentials", id: "definition-field-executionGrant" };
  if (hasKey(topFields, field)) return { label: topFields[field], id: `definition-field-${field}` };
  return { label: "Working definition", id: "definition-edit-controls" };
}
