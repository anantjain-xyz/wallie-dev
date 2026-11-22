import Link from "next/link";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { AGENT_PROVIDER_LABELS } from "@/components/shared/agent-provider-options";
import { SelectField } from "@/components/ui/select";
import { AGENT_PROVIDERS } from "@/lib/agent-config/contracts";
import {
  modelRoutingConfigurationSchema,
  modelRoutingPolicySchema,
  type ModelRoutingConfiguration,
  type ModelRoutingPolicy,
} from "@/lib/model-routing/contracts";

type RoutingRule = ModelRoutingPolicy["rules"][number];
type Constraints = RoutingRule["constraints"];
type FailureKind = RoutingRule["onUnavailable"]["kind"];

const policyFields = modelRoutingPolicySchema.innerType().shape;
const emptyPolicy: ModelRoutingPolicy = {
  version: 1,
  taskClasses: [],
  rules: [],
  onUnmatched: { kind: "escalate" },
};
const emptyConfiguration: ModelRoutingConfiguration = {
  agentId: "",
  definitionRevisionId: "",
  experimentId: "",
  qualificationId: "",
  modelKey: "",
  harness: "codex",
  workerRuntime: "workerd",
};
const initialConstraints: Constraints = {
  qualityFloorBps: 8_000,
  minResolvedTrials: 2,
  maxMeanCostUsd: null,
  maxLatencyMs: null,
  minConfidenceBps: null,
};
const configurationFields = [
  ["agentId", "Agent ID"],
  ["definitionRevisionId", "Definition revision ID"],
  ["experimentId", "Benchmark comparison ID"],
  ["qualificationId", "Capability qualification ID"],
  ["scorerRevisionId", "Frozen scorer revision ID"],
  ["modelKey", "Model ID"],
] as const;

const thresholdFields = [
  {
    key: "qualityFloorBps",
    label: "Quality floor (%)",
    min: 0,
    max: 100,
    step: 0.01,
    scale: 100,
    required: true,
  },
  {
    key: "minResolvedTrials",
    label: "Minimum resolved trials",
    min: 2,
    max: 10_000,
    step: 1,
    scale: 1,
    required: true,
  },
  {
    key: "maxMeanCostUsd",
    label: "Maximum mean cost (USD)",
    min: 0,
    max: 1_000_000,
    step: "any",
    scale: 1,
    required: false,
  },
  {
    key: "maxLatencyMs",
    label: "Maximum p95 wall latency (ms)",
    min: 1,
    max: 86_400_000,
    step: 1,
    scale: 1,
    required: false,
  },
  {
    key: "minConfidenceBps",
    label: "Minimum confidence (%)",
    min: 0,
    max: 100,
    step: 0.01,
    scale: 100,
    required: false,
  },
] as const;

function RoutingField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function FailureChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FailureKind;
  onChange: (kind: FailureKind) => void;
}) {
  return (
    <SelectField
      label={label}
      onValueChange={(next) => {
        const mapped: FailureKind = next === "fallback" ? "fallback" : "escalate";
        if (mapped !== value) onChange(mapped);
      }}
      options={[
        { label: "Escalate", value: "escalate" },
        { label: "Use fallback", value: "fallback" },
      ]}
      value={value}
    />
  );
}

function ConfigurationFields({
  title,
  value,
  onChange,
}: {
  title: string;
  value: ModelRoutingConfiguration;
  onChange: (configuration: ModelRoutingConfiguration) => void;
}) {
  return (
    <fieldset className="min-w-0 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {configurationFields.map(([key, label]) => (
          <RoutingField key={key} label={label}>
            <input
              className="ui-input font-mono"
              value={value[key] ?? ""}
              required={key !== "scorerRevisionId"}
              onChange={(event) =>
                onChange({
                  ...value,
                  [key]:
                    key === "scorerRevisionId"
                      ? event.target.value || undefined
                      : event.target.value,
                })
              }
            />
          </RoutingField>
        ))}
        <SelectField
          label="Harness"
          onValueChange={(next) => {
            const harness = modelRoutingConfigurationSchema.shape.harness.parse(next);
            if (harness !== value.harness) onChange({ ...value, harness });
          }}
          options={AGENT_PROVIDERS.map((provider) => ({
            label: AGENT_PROVIDER_LABELS[provider],
            value: provider,
          }))}
          value={value.harness}
        />
        <SelectField
          label="Worker runtime"
          onValueChange={(next) => {
            const workerRuntime = modelRoutingConfigurationSchema.shape.workerRuntime.parse(next);
            if (workerRuntime !== value.workerRuntime) onChange({ ...value, workerRuntime });
          }}
          options={[
            { label: "Node.js", value: "node" },
            { label: "Cloudflare Workers", value: "workerd" },
          ]}
          value={value.workerRuntime}
        />
      </div>
    </fieldset>
  );
}

function ThresholdFields({
  value,
  onChange,
}: {
  value: Constraints;
  onChange: (constraints: Constraints) => void;
}) {
  return (
    <fieldset className="min-w-0 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">Evidence requirements</legend>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {thresholdFields.map(({ key, label, min, max, step, scale, required }) => {
          const threshold = value[key];
          return (
            <RoutingField key={key} label={label}>
              <input
                className="ui-input"
                type="number"
                min={min}
                max={max}
                step={step}
                required={required}
                value={threshold !== null && Number.isFinite(threshold) ? threshold / scale : ""}
                onChange={(event) => {
                  const number = event.target.valueAsNumber;
                  const next = scale === 100 ? Math.round(number * scale) : number;
                  onChange({
                    ...value,
                    [key]: required || event.target.value !== "" ? next : null,
                  });
                }}
              />
            </RoutingField>
          );
        })}
      </div>
    </fieldset>
  );
}

function RuleFields({
  value,
  onChange,
}: {
  value: RoutingRule;
  onChange: (rule: RoutingRule) => void;
}) {
  const { onUnavailable } = value;
  return (
    <div className="space-y-3">
      <ConfigurationFields
        title="Primary configuration"
        value={value.configuration}
        onChange={(configuration) => onChange({ ...value, configuration })}
      />
      <ThresholdFields
        value={value.constraints}
        onChange={(constraints) => onChange({ ...value, constraints })}
      />
      <FailureChoice
        label="When the primary is unavailable"
        value={onUnavailable.kind}
        onChange={(kind) =>
          onChange({
            ...value,
            onUnavailable:
              kind === "fallback" ? { kind, configuration: emptyConfiguration } : { kind },
          })
        }
      />
      {onUnavailable.kind === "fallback" ? (
        <ConfigurationFields
          title="Rule fallback configuration"
          value={onUnavailable.configuration}
          onChange={(configuration) =>
            onChange({ ...value, onUnavailable: { ...onUnavailable, configuration } })
          }
        />
      ) : null}
    </div>
  );
}

function ItemOrder({
  name,
  index,
  count,
  move,
}: {
  name: string;
  index: number;
  count: number;
  move: (offset: -1 | 1) => void;
}) {
  return (
    <>
      <button
        aria-label={"Move " + name + " up"}
        className="ui-button"
        disabled={index === 0}
        onClick={() => move(-1)}
        type="button"
      >
        Move up
      </button>
      <button
        aria-label={"Move " + name + " down"}
        className="ui-button"
        disabled={index + 1 === count}
        onClick={() => move(1)}
        type="button"
      >
        Move down
      </button>
    </>
  );
}

function moveItem<T>(items: T[], index: number, offset: -1 | 1) {
  const target = index + offset;
  const next = items.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function ModelRoutingEditor({
  benchmarksHref,
  value,
  onChange,
}: {
  benchmarksHref?: string;
  value: ModelRoutingPolicy | undefined;
  onChange: (policy: ModelRoutingPolicy | undefined) => void;
}) {
  const id = useId();
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const focusNext = useRef<string>(null);
  const { taskClasses, rules, onUnmatched } = value ?? emptyPolicy;
  const usedClasses = new Set(rules.map(({ taskClassId }) => taskClassId));
  const unassigned = taskClasses.find(({ id }) => !usedClasses.has(id));

  useLayoutEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  }, [value]);

  const classInputId = (taskClassId: string) => id + "-class-" + taskClassId;
  const ruleToggleId = (ruleId: string) => id + "-rule-" + ruleId;

  function update(patch: Partial<ModelRoutingPolicy>) {
    onChange({ ...emptyPolicy, ...value, ...patch });
  }

  function addClass() {
    const next = policyFields.taskClasses.element.shape.id.parse(crypto.randomUUID());
    focusNext.current = classInputId(next);
    update({ taskClasses: [...taskClasses, { id: next, name: "", slug: "" }] });
  }

  function addRule() {
    if (!unassigned) return;
    const next = policyFields.rules.element.shape.id.parse(crypto.randomUUID());
    focusNext.current = ruleToggleId(next);
    setExpandedRule(next);
    update({
      rules: [
        ...rules,
        {
          id: next,
          taskClassId: unassigned.id,
          configuration: emptyConfiguration,
          constraints: initialConstraints,
          onUnavailable: { kind: "escalate" },
        },
      ],
    });
  }

  function updateRule(index: number, rule: RoutingRule) {
    update({ rules: rules.map((current, position) => (position === index ? rule : current)) });
  }

  return (
    <section aria-labelledby={id} className="min-w-0 space-y-4 border-t border-border pt-6">
      <h3 className="type-section-title text-foreground" id={id}>
        Model routing
      </h3>
      {!value ? (
        <button
          className="ui-button"
          id={id + "-add-policy"}
          onClick={() => {
            focusNext.current = id + "-add-class";
            onChange(emptyPolicy);
          }}
          type="button"
        >
          Add routing policy
        </button>
      ) : (
        <>
          <p className="type-secondary text-muted">
            Match each task class to the slug of its first selected stage.
            {benchmarksHref ? (
              <>
                {" "}
                Use{" "}
                <Link
                  className="text-accent underline underline-offset-2"
                  href={benchmarksHref}
                  prefetch={false}
                  rel="noreferrer"
                  target="_blank"
                >
                  Benchmarks (opens in a new tab)
                </Link>{" "}
                to apply a qualified configuration.
              </>
            ) : null}
          </p>
          <p className="sr-only" role="status">
            {announcement}
          </p>
          <fieldset className="min-w-0 space-y-3">
            <legend className="mb-2 text-sm font-medium">Task classes</legend>
            <ol className="space-y-3">
              {taskClasses.map((entry, index) => {
                const classLabel = entry.name || "task class " + (index + 1);
                return (
                  <li
                    className="min-w-0 space-y-3 rounded-md border border-border p-3"
                    key={entry.id}
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <RoutingField label="Task class name">
                        <input
                          className="ui-input"
                          id={classInputId(entry.id)}
                          maxLength={120}
                          onChange={(event) =>
                            update({
                              taskClasses: taskClasses.map((item) =>
                                item.id === entry.id ? { ...item, name: event.target.value } : item,
                              ),
                            })
                          }
                          value={entry.name}
                        />
                      </RoutingField>
                      <RoutingField label="Task class slug">
                        <input
                          className="ui-input font-mono"
                          maxLength={60}
                          onChange={(event) =>
                            update({
                              taskClasses: taskClasses.map((item) =>
                                item.id === entry.id ? { ...item, slug: event.target.value } : item,
                              ),
                            })
                          }
                          value={entry.slug}
                        />
                      </RoutingField>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ItemOrder
                        name={classLabel}
                        index={index}
                        count={taskClasses.length}
                        move={(offset) => {
                          focusNext.current = classInputId(entry.id);
                          setAnnouncement(
                            "Moved " + classLabel + " to position " + (index + offset + 1) + ".",
                          );
                          update({ taskClasses: moveItem(taskClasses, index, offset) });
                        }}
                      />
                      <button
                        aria-label={
                          "Remove " +
                          classLabel +
                          (usedClasses.has(entry.id) ? " and its rule" : "")
                        }
                        className="ui-button"
                        onClick={() => {
                          focusNext.current = id + "-add-class";
                          update({
                            taskClasses: taskClasses.filter(({ id }) => id !== entry.id),
                            rules: rules.filter(({ taskClassId }) => taskClassId !== entry.id),
                          });
                        }}
                        type="button"
                      >
                        {usedClasses.has(entry.id) ? "Remove class and rule" : "Remove class"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
            <button
              className="ui-button"
              disabled={taskClasses.length >= 100}
              id={id + "-add-class"}
              onClick={addClass}
              type="button"
            >
              Add task class
            </button>
          </fieldset>
          <fieldset className="min-w-0 space-y-3">
            <legend className="mb-2 text-sm font-medium">Routing rules</legend>
            <ol className="space-y-3">
              {rules.map((rule, index) => {
                const expanded = expandedRule === rule.id;
                const className = taskClasses.find(({ id }) => id === rule.taskClassId)?.name;
                const ruleLabel = className ? className + " rule" : "routing rule " + (index + 1);
                const detailsId = ruleToggleId(rule.id) + "-details";
                return (
                  <li
                    className="min-w-0 space-y-3 rounded-md border border-border p-3"
                    key={rule.id}
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <SelectField
                        label="Rule task class"
                        onValueChange={(next) => {
                          const match = taskClasses.find(({ id }) => id === next);
                          if (match && match.id !== rule.taskClassId) {
                            updateRule(index, { ...rule, taskClassId: match.id });
                          }
                        }}
                        options={taskClasses
                          .filter(({ id }) => id === rule.taskClassId || !usedClasses.has(id))
                          .map(({ id, name, slug }) => ({
                            label: name || slug || "Unnamed task class",
                            value: id,
                          }))}
                        value={rule.taskClassId}
                        wrap
                      />
                      {rule.configuration.modelKey ? (
                        <p className="type-secondary min-w-0 self-end break-words text-muted">
                          {rule.configuration.modelKey}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        aria-controls={expanded ? detailsId : undefined}
                        aria-expanded={expanded}
                        aria-label={(expanded ? "Hide " : "Edit ") + ruleLabel}
                        className="ui-button"
                        id={ruleToggleId(rule.id)}
                        onClick={() => setExpandedRule(expanded ? null : rule.id)}
                        type="button"
                      >
                        {expanded ? "Hide rule details" : "Edit rule details"}
                      </button>
                      <ItemOrder
                        name={ruleLabel}
                        index={index}
                        count={rules.length}
                        move={(offset) => {
                          focusNext.current = ruleToggleId(rule.id);
                          setAnnouncement(
                            "Moved " + ruleLabel + " to position " + (index + offset + 1) + ".",
                          );
                          update({ rules: moveItem(rules, index, offset) });
                        }}
                      />
                      <button
                        aria-label={"Remove " + ruleLabel}
                        className="ui-button"
                        onClick={() => {
                          focusNext.current = id + "-add-rule";
                          update({ rules: rules.filter(({ id }) => id !== rule.id) });
                        }}
                        type="button"
                      >
                        Remove rule
                      </button>
                    </div>
                    {expanded ? (
                      <div id={detailsId}>
                        <RuleFields value={rule} onChange={(next) => updateRule(index, next)} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <button
              className="ui-button"
              disabled={!unassigned}
              id={id + "-add-rule"}
              onClick={addRule}
              type="button"
            >
              Add routing rule
            </button>
          </fieldset>
          <FailureChoice
            label="When no rule matches"
            value={onUnmatched.kind}
            onChange={(kind) =>
              update({
                onUnmatched:
                  kind === "fallback"
                    ? { kind, configuration: emptyConfiguration, constraints: initialConstraints }
                    : { kind },
              })
            }
          />
          {onUnmatched.kind === "fallback" ? (
            <>
              <ConfigurationFields
                title="Unmatched-task fallback configuration"
                value={onUnmatched.configuration}
                onChange={(configuration) =>
                  update({ onUnmatched: { ...onUnmatched, configuration } })
                }
              />
              <ThresholdFields
                value={onUnmatched.constraints}
                onChange={(constraints) => update({ onUnmatched: { ...onUnmatched, constraints } })}
              />
            </>
          ) : null}
          <button
            className="ui-button"
            onClick={() => {
              focusNext.current = id + "-add-policy";
              onChange(undefined);
            }}
            type="button"
          >
            Remove routing policy
          </button>
        </>
      )}
    </section>
  );
}
