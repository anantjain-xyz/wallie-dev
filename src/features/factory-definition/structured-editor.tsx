"use client";

import Link from "next/link";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  AGENT_EFFORT_EMPTY_OPTION,
  AGENT_EFFORT_SELECT_OPTIONS,
  AGENT_PROVIDER_LABELS,
} from "@/components/shared/agent-provider-options";
import { MultiSelectField } from "@/components/ui/multi-select-field";
import { SelectField } from "@/components/ui/select";
import { ContextDocumentsEditor } from "@/features/factory-definition/context-documents-editor";
import { FactoryRepositoryBindingsEditor } from "@/features/factory-definition/repository-bindings-editor";
import { ModelRoutingEditor } from "@/features/factory-definition/model-routing-editor";
import {
  AGENT_CONFIG_LIMITS,
  AGENT_PROVIDERS,
  STALL_TIMEOUT_MINUTE_LIMITS,
  agentConfigValueSchemas,
  agentProviderSupportsEffort,
  getRecommendedAgentModel,
  stallTimeoutMinutesToMs,
  stallTimeoutMsToMinutes,
} from "@/lib/agent-config/contracts";
import { grantReferenceKey } from "@/lib/factory-definitions/named-reference-contracts";
import type { ContextDocumentReference } from "@/lib/factory-context/contracts";
import type { RoutingQualificationStatus } from "@/lib/model-routing/qualification-status";
import {
  FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
  MAX_FACTORY_SCORER_REVISIONS,
  type SerialFactoryDefinition,
} from "@/lib/factory-definitions/schema";
import { MAX_MCP_BINDINGS, mcpOperationScopeId } from "@/lib/factory-mcp/manifest";
import { MAX_FACTORY_SKILL_REVISIONS } from "@/lib/factory-skills/contracts";
import { SANDBOX_PROVIDERS, sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

import {
  displayedReference,
  findReference,
  ReferenceDetails,
  ReferencePicker,
  ReferenceSelectionList,
  type ReferencePickerCatalog,
} from "./named-references";

type ToolBinding = NonNullable<SerialFactoryDefinition["mcpBindings"]>[number];
type Stage = SerialFactoryDefinition["stages"][number];

const sandboxLabels = {
  vercel: "Vercel Sandbox",
  e2b: "E2B",
  daytona: "Daytona",
} satisfies Record<SerialFactoryDefinition["sandboxProvider"], string>;

const referenceFields = [
  {
    key: "pipeline",
    label: "Pipeline",
    empty: "Choose a pipeline",
    unavailable: "Pipeline unavailable",
  },
  {
    key: "executionPolicy",
    label: "Execution policy revision",
    empty: "No policy pinned",
    unavailable: "Execution policy revision unavailable",
  },
  {
    key: "deliveryPolicy",
    label: "Delivery policy revision",
    empty: "No policy pinned",
    unavailable: "Delivery policy revision unavailable",
  },
] as const satisfies readonly {
  key: keyof SerialFactoryDefinition;
  label: string;
  empty: string;
  unavailable: string;
}[];

const numericAgentFields = [
  {
    key: "concurrencyLimit",
    label: "Concurrency limit",
    ...AGENT_CONFIG_LIMITS.concurrency_limit,
  },
  {
    key: "stallTimeoutMs",
    label: "Stall timeout (minutes)",
    ...STALL_TIMEOUT_MINUTE_LIMITS,
  },
  { key: "maxRetries", label: "Maximum retries", ...AGENT_CONFIG_LIMITS.max_retries },
  { key: "maxTurns", label: "Maximum turns", ...AGENT_CONFIG_LIMITS.max_turns },
] as const satisfies readonly {
  key: keyof SerialFactoryDefinition["agent"];
  label: string;
  min: number;
  max: number;
}[];

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function TextField({
  id,
  label,
  maxLength,
  onChange,
  value,
}: {
  id?: string;
  label: string;
  maxLength?: number;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <Field label={label}>
      <input
        className="ui-input"
        id={id}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        type="text"
        value={value}
      />
    </Field>
  );
}

export function withImplementationAgent(
  value: SerialFactoryDefinition,
  revisionId: string | undefined,
  previousAgentId: string | undefined,
  agentId: string | undefined,
) {
  const next = { ...value, implementationAgent: revisionId };
  if (!agentId || agentId !== previousAgentId) {
    delete next.credentialBindingId;
    next.mcpBindings = value.mcpBindings?.map((binding) => ({
      ...binding,
      secretBindingId: undefined,
    }));
  }
  return next;
}

export function StructuredFactoryDefinitionEditor({
  agentsHref,
  benchmarksHref,
  contextHref,
  contextProposal,
  governanceHref,
  disabled,
  expandAdvanced,
  namedReferences,
  onChange,
  publishedAgentRevision,
  repositories,
  routingQualification,
  workingAgent,
  value,
}: {
  agentsHref?: string;
  benchmarksHref?: string;
  contextHref?: string;
  contextProposal?: ContextDocumentReference;
  governanceHref?: string;
  disabled?: boolean;
  expandAdvanced?: boolean;
  namedReferences?: ReferencePickerCatalog;
  onChange: (value: SerialFactoryDefinition) => void;
  publishedAgentRevision?: string;
  repositories: Parameters<typeof FactoryRepositoryBindingsEditor>[0]["repositories"];
  routingQualification?: RoutingQualificationStatus;
  workingAgent?: { revisionId: string; agentId: string };
  value: SerialFactoryDefinition;
}) {
  const editorId = useId();
  const focusNext = useRef<string>(null);
  const [stageAnnouncement, setStageAnnouncement] = useState("");
  const { agent, stages, mcpBindings = [], executionGrant } = value;
  const skillOptions = namedReferences?.options.skills ?? [];
  const scorerRevisionIds =
    value.schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
      ? value.scorerRevisionIds
      : [];
  const scorerOptions = namedReferences?.options.scorers ?? [];
  const toolOptions = namedReferences?.options.tools ?? [];
  const pipelineOptions = namedReferences?.options.pipeline ?? [];
  const pipelineId = findReference(pipelineOptions, value.pipeline)?.id ?? value.pipeline;
  const grantOptions = namedReferences?.options.grants ?? [];
  const grantKey = executionGrant
    ? grantReferenceKey(executionGrant.id, executionGrant.version)
    : "";
  const grant = findReference(grantOptions, grantKey);
  const promptChoices = (namedReferences?.options.implementationAgent ?? []).map((option) =>
    option.id === publishedAgentRevision
      ? { ...option, label: `${option.label} · Published` }
      : option,
  );
  const currentAgentId = value.implementationAgent
    ? (findReference(promptChoices, value.implementationAgent)?.agentId ??
      (workingAgent?.revisionId === value.implementationAgent ? workingAgent.agentId : undefined))
    : undefined;
  const approvers = namedReferences?.options.approvers ?? [];
  const stageKeys = new Set<string>();

  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    document.getElementById(target)?.focus();
  }, [stages]);

  function update<K extends keyof SerialFactoryDefinition>(
    key: K,
    next: SerialFactoryDefinition[K],
  ) {
    onChange({ ...value, [key]: next });
  }

  function updateScorers(ids: string[]) {
    onChange({
      ...value,
      schemaVersion: FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
      scorerRevisionIds: ids,
    });
  }

  function updateTool(index: number, patch: Partial<ToolBinding>) {
    update(
      "mcpBindings",
      mcpBindings.map((binding, currentIndex) =>
        currentIndex === index ? { ...binding, ...patch } : binding,
      ),
    );
  }

  function updateAgent(patch: Partial<SerialFactoryDefinition["agent"]>) {
    update("agent", { ...agent, ...patch });
  }

  function updateStage(index: number, patch: Partial<Stage>) {
    update(
      "stages",
      stages.map((stage, currentIndex) =>
        currentIndex === index ? { ...stage, ...patch } : stage,
      ),
    );
  }

  function addStage() {
    const id = crypto.randomUUID();
    const stageNumber = stages.length + 1;
    const usedSlugs = new Set(stages.map(({ slug }) => slug));
    let nextSlugNumber = stageNumber;
    while (usedSlugs.has(`stage-${nextSlugNumber}`)) nextSlugNumber += 1;
    focusNext.current = `definition-field-stages-${stages.length}-name`;
    setStageAnnouncement(`Added stage ${stageNumber}.`);
    update("stages", [
      ...stages,
      {
        id,
        name: `Stage ${stageNumber}`,
        slug: `stage-${nextSlugNumber}`,
        description: "",
        promptTemplateMd: "",
        anyoneCanApprove: false,
        approverMemberIds: [],
      },
    ]);
  }

  function moveStage(index: number, offset: -1 | 1) {
    const target = index + offset;
    const stage = stages[index];
    const adjacent = stages[target];
    if (!stage || !adjacent) return;
    const next = stages.slice();
    next[index] = adjacent;
    next[target] = stage;
    focusNext.current = `${editorId}-stage-${target}-title`;
    setStageAnnouncement(`Moved ${stage.name || "stage"} to position ${target + 1}.`);
    update("stages", next);
  }

  function removeStage(index: number) {
    const stage = stages[index];
    if (!stage || stages.length <= 1) return;
    const next = stages.filter((_, currentIndex) => currentIndex !== index);
    const adjacent = Math.min(index, next.length - 1);
    focusNext.current = `${editorId}-stage-${adjacent}-title`;
    setStageAnnouncement(`Removed ${stage.name || "stage"}.`);
    update("stages", next);
  }

  const advancedFields = (
    <>
      <section
        aria-labelledby={`${editorId}-runtime`}
        className="min-w-0 space-y-4 border-t border-border pt-6"
      >
        <h3 className="type-section-title text-foreground" id={`${editorId}-runtime`}>
          Runtime
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="definition-field-sandboxProvider"
            disabled={disabled}
            label="Sandbox provider"
            onValueChange={(next) => {
              if (disabled) return;
              const provider = sandboxProviderSchema.safeParse(next);
              if (provider.success) update("sandboxProvider", provider.data);
            }}
            options={SANDBOX_PROVIDERS.map((provider) => ({
              label: sandboxLabels[provider],
              value: provider,
            }))}
            value={value.sandboxProvider}
          />
          <SelectField
            id="definition-field-agent-provider"
            disabled={disabled}
            label="Agent provider"
            onValueChange={(next) => {
              if (disabled) return;
              const provider = agentConfigValueSchemas.agent_provider.safeParse(next);
              if (!provider.success || provider.data === agent.provider) return;
              updateAgent({
                provider: provider.data,
                model: getRecommendedAgentModel(provider.data),
                effort: agentProviderSupportsEffort(provider.data) ? agent.effort : null,
              });
            }}
            options={AGENT_PROVIDERS.map((provider) => ({
              label: AGENT_PROVIDER_LABELS[provider],
              value: provider,
            }))}
            value={agent.provider}
          />
          <TextField
            id="definition-field-agent-model"
            label="Model"
            onChange={(model) => updateAgent({ model })}
            value={agent.model}
          />
          <SelectField
            id="definition-field-agent-effort"
            disabled={
              disabled || (!agentProviderSupportsEffort(agent.provider) && agent.effort === null)
            }
            emptyOption={AGENT_EFFORT_EMPTY_OPTION}
            label="Reasoning effort"
            onValueChange={(effort) => {
              if (disabled) return;
              if (!effort) {
                updateAgent({ effort: null });
                return;
              }
              const parsed = agentConfigValueSchemas.agent_effort.safeParse(effort);
              if (parsed.success) updateAgent({ effort: parsed.data });
            }}
            options={AGENT_EFFORT_SELECT_OPTIONS}
            value={agent.effort ?? ""}
          />
          {numericAgentFields.map(({ key, label, min, max }) => {
            const number =
              key === "stallTimeoutMs" ? stallTimeoutMsToMinutes(agent[key]) : agent[key];
            return (
              <Field key={key} label={label}>
                <input
                  className="ui-input"
                  id={`definition-field-agent-${key}`}
                  max={max}
                  min={min}
                  onChange={(event) => {
                    const next = event.target.valueAsNumber;
                    updateAgent({
                      [key]: key === "stallTimeoutMs" ? stallTimeoutMinutesToMs(next) : next,
                    });
                  }}
                  step={key === "stallTimeoutMs" ? "any" : 1}
                  type="number"
                  value={Number.isFinite(number) ? number : ""}
                />
              </Field>
            );
          })}
        </div>
      </section>

      <section
        aria-labelledby={`${editorId}-references`}
        className="min-w-0 space-y-4 border-t border-border pt-6"
      >
        <h3 className="type-section-title text-foreground" id={`${editorId}-references`}>
          References
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {referenceFields.map(({ key, label, empty, unavailable }) => {
            const options = namedReferences?.options[key] ?? [];
            const selected = findReference(options, value[key] ?? "");
            const matchesPipeline =
              key !== "deliveryPolicy" || !selected || selected.pipelineId === pipelineId;
            return (
              <ReferencePicker
                key={key}
                id={`definition-field-${key}`}
                catalog={namedReferences}
                kind={key}
                options={
                  key === "deliveryPolicy"
                    ? options.filter(
                        (option) => option.pipelineId === pipelineId || option.id === value[key],
                      )
                    : options
                }
                label={label}
                empty={empty}
                unavailable={unavailable}
                selectedAllowed={matchesPipeline}
                onChange={(next) => update(key, key === "pipeline" ? next : next || null)}
                value={value[key] ?? ""}
                disabled={disabled}
              />
            );
          })}
          <div className="space-y-1.5">
            <ReferencePicker
              catalog={namedReferences}
              kind="implementationAgent"
              id="definition-field-implementationAgent"
              label="Implementation agent prompt revision"
              onChange={(next) =>
                onChange(
                  withImplementationAgent(
                    value,
                    next || undefined,
                    currentAgentId,
                    findReference(promptChoices, next)?.agentId,
                  ),
                )
              }
              empty="Use factory default"
              unavailable="Agent prompt revision unavailable"
              options={promptChoices}
              value={value.implementationAgent ?? ""}
              disabled={disabled}
            />
            {value.implementationAgent ? (
              <ReferenceDetails value={value.implementationAgent} />
            ) : null}
            <p className="type-annotation text-muted">
              Agent instructions are fixed text. Template variables stay literal.
              {agentsHref ? (
                <>
                  {" "}
                  <Link
                    className="text-accent underline underline-offset-2"
                    href={agentsHref}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Browse agents (new tab)
                  </Link>
                  .
                </>
              ) : null}
            </p>
          </div>
          <ReferenceSelectionList
            id="definition-field-skills"
            catalog={namedReferences}
            kind="skills"
            label="Skills"
            addLabel="Add a skill revision"
            empty="No skill revisions selected."
            unavailable="Skill revision unavailable"
            onChange={(next) => {
              if (next.length <= MAX_FACTORY_SKILL_REVISIONS) update("skills", next);
            }}
            values={value.skills}
            options={skillOptions}
            disabled={disabled}
            limit={MAX_FACTORY_SKILL_REVISIONS}
          />
        </div>
      </section>

      <section
        aria-labelledby={`${editorId}-scorers`}
        className="min-w-0 space-y-3 border-t border-border pt-6"
      >
        <h3 className="type-section-title text-foreground" id={`${editorId}-scorers`}>
          Scorers
        </h3>
        <ReferenceSelectionList
          id="definition-field-scorerRevisionIds"
          catalog={namedReferences}
          kind="scorers"
          label="Scorers"
          addLabel="Add a scorer revision"
          empty="No scorer revisions selected."
          unavailable="Scorer revision unavailable"
          onChange={(next) => {
            if (next.length <= MAX_FACTORY_SCORER_REVISIONS) updateScorers(next);
          }}
          values={scorerRevisionIds}
          options={scorerOptions}
          disabled={disabled}
          limit={MAX_FACTORY_SCORER_REVISIONS}
        />
      </section>

      <section
        aria-labelledby="definition-field-mcpBindings"
        className="min-w-0 space-y-4 border-t border-border pt-6"
      >
        <h3
          className="type-section-title text-foreground"
          id="definition-field-mcpBindings"
          tabIndex={-1}
        >
          Tool bindings
        </h3>
        {mcpBindings.length ? (
          <ol className="space-y-4">
            {mcpBindings.map((binding, index) => {
              const tool = findReference(toolOptions, binding.toolRevisionId);
              const permittedOperations =
                tool?.unavailable || grant?.unavailable
                  ? []
                  : (tool?.operations?.filter((operation) =>
                      grant?.toolIds?.includes(
                        mcpOperationScopeId(binding.toolRevisionId, operation),
                      ),
                    ) ?? []);
              const credentials = namedReferences?.options.bindings ?? [];
              const eligibleBinding = (option: (typeof credentials)[number]) =>
                Boolean(
                  tool?.authKind === "bearer" &&
                  grant &&
                  !grant.unavailable &&
                  permittedOperations.length &&
                  currentAgentId &&
                  option.agentId === currentAgentId &&
                  option.grantId === executionGrant?.id &&
                  option.principalId === grant.principalId &&
                  option.toolId === binding.toolRevisionId,
                );
              const selectedBinding = findReference(credentials, binding.secretBindingId ?? "");
              return (
                <li className="min-w-0 space-y-4 rounded-md border border-border p-4" key={index}>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ReferencePicker
                      catalog={namedReferences}
                      kind="tools"
                      id={`definition-field-mcpBindings-${index}-toolRevisionId`}
                      label={`Tool revision ${index + 1}`}
                      options={toolOptions.filter(
                        ({ id }) =>
                          id === binding.toolRevisionId ||
                          !mcpBindings.some((other) => other.toolRevisionId === id),
                      )}
                      onChange={(toolRevisionId) => {
                        if (toolRevisionId === binding.toolRevisionId) return;
                        updateTool(index, {
                          toolRevisionId,
                          operations: [],
                          secretBindingId: undefined,
                        });
                      }}
                      empty="Choose an approved tool revision"
                      unavailable="Tool revision unavailable"
                      disabled={disabled}
                      value={binding.toolRevisionId}
                    />
                    {tool?.authKind === "bearer" || binding.secretBindingId ? (
                      <ReferencePicker
                        catalog={namedReferences}
                        kind="bindings"
                        id={`definition-field-mcpBindings-${index}-secretBindingId`}
                        label="MCP secret binding"
                        options={credentials.filter(
                          (option) =>
                            eligibleBinding(option) || option.id === binding.secretBindingId,
                        )}
                        selectedAllowed={!selectedBinding || eligibleBinding(selectedBinding)}
                        onChange={(id) => updateTool(index, { secretBindingId: id || undefined })}
                        empty="Credential required · choose a saved binding"
                        unavailable="Credential binding unavailable"
                        value={binding.secretBindingId ?? ""}
                        disabled={disabled}
                      />
                    ) : tool?.authKind === "none" ? (
                      <p className="type-secondary self-end text-muted">
                        No authentication required.
                      </p>
                    ) : null}
                  </div>
                  <MultiSelectField
                    description="Choose operations approved by both this tool revision and the execution grant."
                    disabled={disabled}
                    emptyMessage="Choose a tool revision and a grant with approved operations."
                    id={`definition-field-mcpBindings-${index}-operations`}
                    label="Allowed operations"
                    options={[...new Set([...permittedOperations, ...binding.operations])].map(
                      (name) => ({
                        value: name,
                        label: permittedOperations.includes(name) ? name : `${name} · Unavailable`,
                      }),
                    )}
                    summary={
                      binding.operations.length
                        ? `${binding.operations.length} selected`
                        : "Choose operations"
                    }
                    onValuesChange={(operations) => updateTool(index, { operations })}
                    values={binding.operations}
                  />
                  <button
                    aria-label={`Remove tool binding ${index + 1}`}
                    className="ui-button"
                    onClick={() => {
                      const remaining = mcpBindings.filter((_, position) => position !== index);
                      update("mcpBindings", remaining.length ? remaining : undefined);
                    }}
                    type="button"
                  >
                    Remove binding
                  </button>
                </li>
              );
            })}
          </ol>
        ) : null}
        <button
          className="ui-button"
          disabled={mcpBindings.length >= MAX_MCP_BINDINGS}
          onClick={() =>
            update("mcpBindings", [...mcpBindings, { toolRevisionId: "", operations: [] }])
          }
          type="button"
        >
          Add tool binding
        </button>
      </section>

      <section
        aria-labelledby={`${editorId}-authority`}
        className="min-w-0 space-y-4 border-t border-border pt-6"
      >
        <h3 className="type-section-title text-foreground" id={`${editorId}-authority`}>
          Execution authority
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <ReferencePicker
            catalog={namedReferences}
            kind="grants"
            id="definition-field-executionGrant"
            label="Execution grant"
            options={grantOptions}
            onChange={(key) => {
              if (key === grantKey) return;
              const next = findReference(grantOptions, key);
              if (key && (!next?.grantId || !next.version)) return;
              onChange({
                ...value,
                credentialBindingId: undefined,
                executionGrant:
                  next?.grantId && next.version
                    ? { id: next.grantId, version: next.version }
                    : undefined,
                mcpBindings: value.mcpBindings?.map((binding) => ({
                  ...binding,
                  secretBindingId: undefined,
                })),
              });
            }}
            empty="Use session creator"
            unavailable={`Grant unavailable${executionGrant ? ` · v${executionGrant.version}` : ""}`}
            value={grantKey}
            disabled={disabled}
          />
        </div>
        {executionGrant ? (
          <ReferenceDetails value={`${executionGrant.id} · v${executionGrant.version}`} />
        ) : null}
        <p className="type-annotation text-muted">
          Save the grant in the draft to attach its service credential. Secret values stay in
          Settings.
          {governanceHref ? (
            <>
              {" "}
              <Link
                className="text-accent underline underline-offset-2"
                href={governanceHref}
                target="_blank"
                rel="noreferrer"
              >
                Review execution grants (new tab)
              </Link>
              .
            </>
          ) : null}
        </p>
      </section>
      <ContextDocumentsEditor
        catalog={namedReferences}
        contextHref={contextHref}
        grant={executionGrant}
        value={value.contextDocuments}
        proposal={contextProposal}
        disabled={disabled}
        onChange={(next) => update("contextDocuments", next)}
      />

      <ModelRoutingEditor
        benchmarksHref={benchmarksHref}
        catalog={namedReferences}
        qualification={routingQualification}
        disabled={disabled}
        onChange={(next) => update("modelRouting", next)}
        value={value.modelRouting}
      />
    </>
  );

  return (
    <fieldset className="min-w-0 space-y-7" disabled={disabled}>
      <legend className="sr-only">Structured factory definition</legend>

      <section aria-labelledby="definition-field-repositories" className="min-w-0 space-y-4">
        <h3
          className="type-section-title text-foreground"
          id="definition-field-repositories"
          tabIndex={-1}
        >
          Repository bindings
        </h3>
        <FactoryRepositoryBindingsEditor
          onChange={(patch) => onChange({ ...value, ...patch })}
          repositories={repositories}
          value={value}
        />
      </section>

      <section
        aria-labelledby="definition-field-stages"
        className="min-w-0 space-y-4 border-t border-border pt-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3
            className="type-section-title scroll-mt-24 text-foreground"
            id="definition-field-stages"
            tabIndex={-1}
          >
            Pipeline
          </h3>
          <button
            className="ui-button"
            id={`${editorId}-add-stage`}
            onClick={addStage}
            type="button"
          >
            Add stage
          </button>
        </div>
        {!stages.length ? (
          <p className="type-secondary text-muted">
            Add the first stage. Stages run in order and wait for approval before continuing.
          </p>
        ) : null}
        <details className="min-w-0 space-y-2">
          <summary className="w-fit cursor-pointer py-1 text-sm font-medium">
            Pipeline-wide rules
          </summary>
          <Field label="Operating rules">
            <textarea
              className="ui-textarea font-mono"
              id="definition-field-operatingRulesMd"
              maxLength={20_000}
              onChange={(event) => update("operatingRulesMd", event.target.value)}
              rows={4}
              value={value.operatingRulesMd}
            />
          </Field>
        </details>
        <p className="sr-only" role="status">
          {stageAnnouncement}
        </p>
        <ol aria-label="Stage order" className="space-y-3">
          {stages.map((stage, index) => {
            const stageLabel = stage.name.trim() || `Stage ${index + 1}`;
            const stagePrefix = `${editorId}-stage-${index}`;
            const stageField = `definition-field-stages-${index}`;
            const key = stageKeys.has(stage.id) ? `${stage.id}:${index}` : stage.id;
            stageKeys.add(stage.id);
            return (
              <li
                aria-labelledby={`${stagePrefix}-title`}
                className="min-w-0 space-y-4 rounded-[6px] border border-border bg-sheet p-4"
                key={key}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4
                    className="min-w-0 break-words text-sm font-semibold text-foreground"
                    id={`${stagePrefix}-title`}
                    tabIndex={-1}
                  >
                    {index + 1}. {stageLabel}
                  </h4>
                  <div className="flex min-w-0 flex-wrap gap-1.5">
                    <button
                      className="ui-button"
                      aria-label={`Move ${stageLabel} up`}
                      disabled={index === 0}
                      onClick={() => moveStage(index, -1)}
                      type="button"
                    >
                      Move up
                    </button>
                    <button
                      className="ui-button"
                      aria-label={`Move ${stageLabel} down`}
                      disabled={index === stages.length - 1}
                      onClick={() => moveStage(index, 1)}
                      type="button"
                    >
                      Move down
                    </button>
                    <button
                      className="ui-button"
                      aria-label={`Remove ${stageLabel}`}
                      disabled={stages.length === 1}
                      onClick={() => removeStage(index)}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    id={`${stageField}-name`}
                    label="Stage name"
                    maxLength={80}
                    onChange={(name) => updateStage(index, { name })}
                    value={stage.name}
                  />
                  <TextField
                    id={`${stageField}-slug`}
                    label="Stage slug"
                    maxLength={64}
                    onChange={(slug) => updateStage(index, { slug })}
                    value={stage.slug}
                  />
                </div>
                <TextField
                  id={`${stageField}-description`}
                  label="Description"
                  maxLength={500}
                  onChange={(description) => updateStage(index, { description })}
                  value={stage.description}
                />
                <Field label="Stage prompt">
                  <textarea
                    className="ui-textarea font-mono"
                    id={`${stageField}-promptTemplateMd`}
                    maxLength={20_000}
                    onChange={(event) =>
                      updateStage(index, { promptTemplateMd: event.target.value })
                    }
                    rows={5}
                    value={stage.promptTemplateMd}
                  />
                </Field>
                <fieldset className="space-y-2">
                  <legend className="text-[13px] font-medium">Who can approve?</legend>
                  {[true, false].map((anyone) => (
                    <label
                      key={String(anyone)}
                      className="flex min-h-9 items-center gap-2 text-[13px]"
                    >
                      <input
                        checked={stage.anyoneCanApprove === anyone}
                        className="size-4 accent-accent"
                        id={anyone ? `${stageField}-anyoneCanApprove` : undefined}
                        name={`${stagePrefix}-approval`}
                        onChange={() => updateStage(index, { anyoneCanApprove: anyone })}
                        type="radio"
                      />
                      {anyone ? "Anyone in the workspace" : "Specific members"}
                    </label>
                  ))}
                  {!stage.anyoneCanApprove ? (
                    <>
                      <MultiSelectField
                        id={`${stageField}-approverMemberIds`}
                        label="Approvers"
                        disabled={disabled}
                        description="If no members are selected, workspace owners and admins can approve."
                        emptyMessage="No human members are available."
                        onValuesChange={(approverMemberIds) =>
                          updateStage(index, { approverMemberIds })
                        }
                        options={[
                          ...new Set([
                            ...stage.approverMemberIds,
                            ...approvers
                              .filter(({ unavailable }) => !unavailable)
                              .map(({ id }) => id),
                          ]),
                        ].map((id) => ({
                          value: id,
                          label: displayedReference(
                            findReference(approvers, id),
                            "Workspace member unavailable",
                          ),
                        }))}
                        summary={
                          stage.approverMemberIds.length
                            ? `${stage.approverMemberIds.length} selected`
                            : "Choose members"
                        }
                        values={stage.approverMemberIds}
                      />
                      {namedReferences?.hasMore("approvers") ? (
                        <button
                          className="ui-button"
                          disabled={disabled || Boolean(namedReferences.pending)}
                          onClick={() => namedReferences.loadMore("approvers")}
                          type="button"
                        >
                          {namedReferences.pending === "approvers"
                            ? "Loading members…"
                            : "Show more members"}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </fieldset>
                <ReferenceDetails value={stage.id} />
              </li>
            );
          })}
        </ol>
      </section>
      <details
        className="min-w-0 border-t border-border pt-3"
        id="definition-advanced"
        open={expandAdvanced || undefined}
      >
        <summary className="w-fit cursor-pointer py-2 text-sm font-medium">
          Runtime and advanced settings
        </summary>
        <div className="min-w-0 space-y-7 pt-3">{advancedFields}</div>
      </details>
    </fieldset>
  );
}
