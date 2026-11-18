import type { CompiledFactoryDefinition } from "./compiler";

type Stage = CompiledFactoryDefinition["stages"][number];
type Agent = CompiledFactoryDefinition["agent"];
export type FactoryDiffValue = string | number | boolean | readonly string[] | null;

type DiffField<T> = {
  label: string;
  read: (value: T) => FactoryDiffValue;
  multiline?: true;
};

export type FactoryFieldDifference = {
  label: string;
  before: FactoryDiffValue;
  after: FactoryDiffValue;
  multiline?: true;
};

type FactoryStageDifference = {
  id: string;
  name: string;
  fields: FactoryFieldDifference[];
} & (
  | { kind: "added" | "removed"; position: number }
  | {
      kind: "changed";
      beforePosition: number;
      afterPosition: number;
      orderChanged: boolean;
    }
);

const definitionFields = [
  { label: "Schema version", read: (value) => value.schemaVersion },
  { label: "Workflow kind", read: (value) => value.kind },
  { label: "Pipeline", read: (value) => value.pipelineId },
  { label: "Default writable repository", read: (value) => value.repositoryId },
  { label: "Other writable repositories", read: (value) => value.writableRepositoryIds ?? [] },
  {
    label: "Read-only context repositories",
    read: (value) => value.readContextRepositoryIds ?? [],
  },
  { label: "Implementation agent", read: (value) => value.implementationAgent?.agentId ?? null },
  {
    label: "Agent prompt revision",
    read: (value) => value.implementationAgent?.promptRevisionId ?? null,
  },
  {
    label: "Agent instructions",
    read: (value) => value.implementationAgent?.promptMd ?? null,
    multiline: true,
  },
  { label: "Sandbox provider", read: (value) => value.sandboxProvider },
  { label: "Execution policy revision", read: (value) => value.executionPolicyRevisionId },
  { label: "Service execution grant", read: (value) => value.executionGrant?.id ?? null },
  { label: "Execution grant version", read: (value) => value.executionGrant?.version ?? null },
  { label: "Delivery policy revision", read: (value) => value.deliveryPolicyRevisionId },
  { label: "Skills", read: (value) => value.skillIds },
  { label: "Tools", read: (value) => value.toolIds },
  { label: "Operating rules", read: (value) => value.operatingRulesMd, multiline: true },
  { label: "Operating rule stage references", read: (value) => value.operatingRuleStageIds },
] satisfies readonly DiffField<CompiledFactoryDefinition>[];

const agentFields = [
  { label: "Agent provider", read: (value) => value.provider },
  { label: "Agent model", read: (value) => value.model },
  { label: "Agent effort", read: (value) => value.effort },
  { label: "Agent concurrency limit", read: (value) => value.concurrencyLimit },
  { label: "Agent stall timeout (ms)", read: (value) => value.stallTimeoutMs },
  { label: "Agent max retries", read: (value) => value.maxRetries },
  { label: "Agent max turns", read: (value) => value.maxTurns },
] satisfies readonly DiffField<Agent>[];

const stageFields = [
  { label: "Name", read: (value) => value.name },
  { label: "Slug", read: (value) => value.slug },
  { label: "Description", read: (value) => value.description, multiline: true },
  { label: "Prompt template", read: (value) => value.promptTemplateMd, multiline: true },
  { label: "Any member can approve", read: (value) => value.anyoneCanApprove },
  { label: "Approver member IDs", read: (value) => value.approverMemberIds },
  { label: "Previous stage references", read: (value) => value.previousStageIds },
] satisfies readonly DiffField<Stage>[];

function isEmpty(value: FactoryDiffValue) {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function compareFields<T>(before: T | null, after: T | null, fields: readonly DiffField<T>[]) {
  const changes: FactoryFieldDifference[] = [];
  for (const { label, read, multiline } of fields) {
    const oldValue = before === null ? null : read(before);
    const newValue = after === null ? null : read(after);
    const matches =
      oldValue === newValue ||
      (isEmpty(oldValue) && isEmpty(newValue)) ||
      (Array.isArray(oldValue) &&
        Array.isArray(newValue) &&
        oldValue.length === newValue.length &&
        oldValue.every((value, index) => value === newValue[index]));
    if (!matches) changes.push({ label, before: oldValue, after: newValue, multiline });
  }
  return changes;
}

function stagePositions(stages: readonly Stage[]) {
  return new Map(stages.map((stage, index) => [stage.id, { stage, position: index + 1 }]));
}

function sharedStageRanks(stages: readonly Stage[], other: ReadonlyMap<string, unknown>) {
  return new Map(stages.filter(({ id }) => other.has(id)).map(({ id }, index) => [id, index]));
}

/** Compare compiled settings and stage identities without depending on source formatting. */
export function compareFactoryDefinitions(
  before: CompiledFactoryDefinition | null,
  after: CompiledFactoryDefinition | null,
) {
  const beforeStages = before?.stages ?? [];
  const afterStages = after?.stages ?? [];
  const beforeById = stagePositions(beforeStages);
  const afterById = stagePositions(afterStages);
  const beforeRanks = sharedStageRanks(beforeStages, afterById);
  const afterRanks = sharedStageRanks(afterStages, beforeById);

  const stages: FactoryStageDifference[] = [];
  for (const { stage, position } of afterById.values()) {
    const previous = beforeById.get(stage.id);
    if (!previous) {
      stages.push({
        kind: "added",
        id: stage.id,
        name: stage.name,
        position,
        fields: compareFields(null, stage, stageFields),
      });
      continue;
    }
    const orderChanged = beforeRanks.get(stage.id) !== afterRanks.get(stage.id);
    const fields = compareFields(previous.stage, stage, stageFields);
    if (orderChanged || fields.length) {
      stages.push({
        kind: "changed",
        id: stage.id,
        name: stage.name,
        beforePosition: previous.position,
        afterPosition: position,
        orderChanged,
        fields,
      });
    }
  }
  for (const { stage, position } of beforeById.values()) {
    if (afterById.has(stage.id)) continue;
    stages.push({
      kind: "removed",
      id: stage.id,
      name: stage.name,
      position,
      fields: compareFields(stage, null, stageFields),
    });
  }

  return {
    fields: [
      ...compareFields(before, after, definitionFields),
      ...compareFields(before?.agent ?? null, after?.agent ?? null, agentFields),
    ],
    stages,
  };
}
