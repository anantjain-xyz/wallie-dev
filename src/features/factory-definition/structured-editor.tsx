"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  AGENT_EFFORT_EMPTY_OPTION,
  AGENT_EFFORT_SELECT_OPTIONS,
  AGENT_PROVIDER_LABELS,
} from "@/components/shared/agent-provider-options";
import { FactoryRepositoryBindingsEditor } from "@/features/factory-definition/repository-bindings-editor";
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
import type { SerialFactoryDefinition } from "@/lib/factory-definitions/schema";
import { SANDBOX_PROVIDERS, sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

type Stage = SerialFactoryDefinition["stages"][number];

const sandboxLabels = {
  vercel: "Vercel Sandbox",
  e2b: "E2B",
  daytona: "Daytona",
} satisfies Record<SerialFactoryDefinition["sandboxProvider"], string>;

const referenceFields = [
  { key: "pipeline", label: "Pipeline", placeholder: "Pipeline ID or name" },
  {
    key: "executionPolicy",
    label: "Execution policy revision",
    placeholder: "Optional revision ID",
  },
  {
    key: "deliveryPolicy",
    label: "Delivery policy revision",
    placeholder: "Optional revision ID",
  },
] as const satisfies readonly {
  key: keyof SerialFactoryDefinition;
  label: string;
  placeholder: string;
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
  placeholder,
  value,
}: {
  id?: string;
  label: string;
  maxLength?: number;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <Field label={label}>
      <input
        className="ui-input"
        id={id}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="text"
        value={value}
      />
    </Field>
  );
}

function ReferenceList({
  description,
  label,
  onChange,
  values,
}: {
  description: string;
  label: string;
  onChange: (values: string[]) => void;
  values: string[];
}) {
  const descriptionId = useId();
  const source = values.join("\n");
  const [input, setInput] = useState({ source, text: source });

  return (
    <div className="min-w-0 space-y-1.5">
      <Field label={label}>
        <textarea
          aria-describedby={descriptionId}
          className="ui-textarea font-mono"
          onChange={(event) => {
            const text = event.target.value;
            const references = text
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            setInput({ source: references.join("\n"), text });
            onChange(references);
          }}
          rows={3}
          value={input.source === source ? input.text : source}
        />
      </Field>
      <p className="type-annotation text-muted" id={descriptionId}>
        {description}
      </p>
    </div>
  );
}

export function StructuredFactoryDefinitionEditor({
  disabled,
  onChange,
  repositories,
  value,
}: {
  disabled?: boolean;
  onChange: (value: SerialFactoryDefinition) => void;
  repositories: Parameters<typeof FactoryRepositoryBindingsEditor>[0]["repositories"];
  value: SerialFactoryDefinition;
}) {
  const editorId = useId();
  const focusNext = useRef<string>(null);
  const [stageAnnouncement, setStageAnnouncement] = useState("");
  const { agent, stages } = value;
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
    focusNext.current = `${editorId}-stage-${stages.length}-name`;
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

  return (
    <fieldset className="min-w-0 space-y-7" disabled={disabled}>
      <legend className="sr-only">Structured factory definition</legend>

      <section aria-labelledby={`${editorId}-repositories`} className="min-w-0 space-y-4">
        <h3 className="type-section-title text-foreground" id={`${editorId}-repositories`}>
          Repository bindings
        </h3>
        <FactoryRepositoryBindingsEditor
          onChange={(patch) => onChange({ ...value, ...patch })}
          repositories={repositories}
          value={value}
        />
      </section>

      <section
        aria-labelledby={`${editorId}-references`}
        className="min-w-0 space-y-4 border-t border-border pt-6"
      >
        <h3 className="type-section-title text-foreground" id={`${editorId}-references`}>
          References
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {referenceFields.map(({ key, label, placeholder }) => (
            <TextField
              key={key}
              label={label}
              onChange={(next) => {
                update(key, key === "pipeline" ? next : next || null);
              }}
              placeholder={placeholder}
              value={value[key] ?? ""}
            />
          ))}
          <div className="space-y-1.5">
            <TextField
              label="Implementation agent prompt revision"
              onChange={(next) => update("implementationAgent", next || undefined)}
              placeholder="Optional immutable revision ID"
              value={value.implementationAgent ?? ""}
            />
            <p className="type-annotation text-muted">
              Agent instructions are fixed text. Template variables stay literal.
            </p>
          </div>
          <ReferenceList
            description="One skill revision ID per line."
            label="Skills"
            onChange={(next) => update("skills", next)}
            values={value.skills}
          />
        </div>
      </section>

      <section
        aria-labelledby={`${editorId}-runtime`}
        className="min-w-0 space-y-4 border-t border-border pt-6"
      >
        <h3 className="type-section-title text-foreground" id={`${editorId}-runtime`}>
          Runtime
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sandbox provider">
            <select
              className="ui-select"
              onChange={(event) => {
                const provider = sandboxProviderSchema.safeParse(event.target.value);
                if (provider.success) update("sandboxProvider", provider.data);
              }}
              value={value.sandboxProvider}
            >
              {SANDBOX_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {sandboxLabels[provider]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agent provider">
            <select
              className="ui-select"
              onChange={(event) => {
                const provider = agentConfigValueSchemas.agent_provider.safeParse(
                  event.target.value,
                );
                if (!provider.success || provider.data === agent.provider) return;
                updateAgent({
                  provider: provider.data,
                  model: getRecommendedAgentModel(provider.data),
                  effort: agentProviderSupportsEffort(provider.data) ? agent.effort : null,
                });
              }}
              value={agent.provider}
            >
              {AGENT_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {AGENT_PROVIDER_LABELS[provider]}
                </option>
              ))}
            </select>
          </Field>
          <TextField
            label="Model"
            onChange={(model) => updateAgent({ model })}
            value={agent.model}
          />
          <Field label="Reasoning effort">
            <select
              className="ui-select"
              disabled={!agentProviderSupportsEffort(agent.provider) && agent.effort === null}
              onChange={(event) => {
                const effort = event.target.value;
                if (!effort) {
                  updateAgent({ effort: null });
                  return;
                }
                const parsed = agentConfigValueSchemas.agent_effort.safeParse(effort);
                if (parsed.success) updateAgent({ effort: parsed.data });
              }}
              value={agent.effort ?? ""}
            >
              <option value={AGENT_EFFORT_EMPTY_OPTION.value}>
                {AGENT_EFFORT_EMPTY_OPTION.label}
              </option>
              {AGENT_EFFORT_SELECT_OPTIONS.map(({ label, value: effort }) => (
                <option key={effort} value={effort}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {numericAgentFields.map(({ key, label, min, max }) => {
            const number =
              key === "stallTimeoutMs" ? stallTimeoutMsToMinutes(agent[key]) : agent[key];
            return (
              <Field key={key} label={label}>
                <input
                  className="ui-input"
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
        aria-labelledby={`${editorId}-workflow`}
        className="min-w-0 space-y-4 border-t border-border pt-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="type-section-title text-foreground" id={`${editorId}-workflow`}>
            Workflow
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
        <Field label="Operating rules">
          <textarea
            className="ui-textarea font-mono"
            maxLength={20_000}
            onChange={(event) => update("operatingRulesMd", event.target.value)}
            rows={4}
            value={value.operatingRulesMd}
          />
        </Field>
        <p className="sr-only" role="status">
          {stageAnnouncement}
        </p>
        <ol aria-label="Stage order" className="space-y-3">
          {stages.map((stage, index) => {
            const stageLabel = stage.name.trim() || `Stage ${index + 1}`;
            const stagePrefix = `${editorId}-stage-${index}`;
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
                    id={`${stagePrefix}-name`}
                    label="Stage name"
                    maxLength={80}
                    onChange={(name) => updateStage(index, { name })}
                    value={stage.name}
                  />
                  <TextField
                    label="Stage slug"
                    maxLength={64}
                    onChange={(slug) => updateStage(index, { slug })}
                    value={stage.slug}
                  />
                </div>
                <TextField
                  label="Description"
                  maxLength={500}
                  onChange={(description) => updateStage(index, { description })}
                  value={stage.description}
                />
                <Field label="Stage prompt">
                  <textarea
                    className="ui-textarea font-mono"
                    maxLength={20_000}
                    onChange={(event) =>
                      updateStage(index, { promptTemplateMd: event.target.value })
                    }
                    rows={5}
                    value={stage.promptTemplateMd}
                  />
                </Field>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[13px] font-medium text-foreground">
                  <input
                    checked={stage.anyoneCanApprove}
                    className="h-4 w-4 shrink-0 accent-accent"
                    onChange={(event) =>
                      updateStage(index, { anyoneCanApprove: event.target.checked })
                    }
                    type="checkbox"
                  />
                  Anyone in the workspace can approve
                </label>
                <ReferenceList
                  description="One workspace member ID per line."
                  label="Approvers"
                  onChange={(approverMemberIds) => updateStage(index, { approverMemberIds })}
                  values={stage.approverMemberIds}
                />
                <p className="type-annotation text-muted">
                  Stage ID <code className="break-all font-mono">{stage.id}</code>
                </p>
              </li>
            );
          })}
        </ol>
      </section>
    </fieldset>
  );
}
