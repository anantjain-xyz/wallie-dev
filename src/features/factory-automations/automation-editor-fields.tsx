"use client";

import { useId, useState } from "react";

import { SelectField } from "@/components/ui/select";
import {
  factoryAutomationDefinitionSchema,
  type FactoryAutomationDefinition,
} from "@/lib/factory-automations/contracts";
import {
  automationTriggerKindSchema,
  type AutomationSetupOptions,
  type AutomationTriggerKind,
} from "@/lib/factory-automations/operator-contracts";

import { automationPullRequestActionOptions, automationTriggerLabels } from "./automation-labels";

const triggerOptions = automationTriggerKindSchema.options.map((value) => ({
  value,
  label: automationTriggerLabels[value],
}));

const scheduleOptions = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "hourly", label: "Every hour" },
  { value: "custom", label: "Custom cron" },
];

function scheduleDefaults(cron: string | undefined) {
  if (!cron) return { cadence: "daily", time: "09:00" };
  if (cron === "0 * * * *") return { cadence: "hourly", time: "09:00" };
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron);
  if (!match) return { cadence: "custom", time: "09:00" };
  const [, minute, hour, days] = match;
  return {
    cadence: days === "*" ? "daily" : "weekdays",
    time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
  };
}

function ScheduleFields({
  initial,
  changed,
  disabled,
}: {
  initial: Extract<FactoryAutomationDefinition["trigger"], { kind: "schedule" }> | undefined;
  changed: () => void;
  disabled: boolean;
}) {
  const defaults = scheduleDefaults(initial?.cron);
  const timezones = useId();
  const [cadence, setCadence] = useState(defaults.cadence);

  return (
    <>
      <SelectField
        name="cadence"
        label="Schedule"
        required
        disabled={disabled}
        options={scheduleOptions}
        value={cadence}
        onValueChange={(value) => {
          setCadence(value);
          changed();
        }}
      />
      {cadence === "custom" ? (
        <label className="block min-w-0 space-y-1.5">
          <span className="type-label">Cron expression</span>
          <input
            className="ui-input font-mono"
            name="cron"
            required
            maxLength={120}
            placeholder="0 9 * * 1-5"
            defaultValue={initial?.cron ?? ""}
          />
          <span className="block text-xs text-muted">
            Five fields: minute, hour, day, month, weekday.
          </span>
        </label>
      ) : cadence !== "hourly" ? (
        <label className="block min-w-0 space-y-1.5">
          <span className="type-label">Local time</span>
          <input
            className="ui-input"
            name="localTime"
            type="time"
            required
            defaultValue={defaults.time}
          />
        </label>
      ) : null}
      <label className="block min-w-0 space-y-1.5">
        <span className="type-label">Time zone</span>
        <input
          className="ui-input"
          name="timeZone"
          list={timezones}
          maxLength={80}
          required
          defaultValue={initial?.timeZone ?? "Etc/UTC"}
          autoComplete="off"
        />
        <datalist id={timezones}>
          {[
            "Etc/UTC",
            "America/Los_Angeles",
            "America/New_York",
            "Europe/London",
            "Europe/Berlin",
            "Asia/Kolkata",
            "Asia/Tokyo",
            "Australia/Sydney",
          ].map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </label>
    </>
  );
}

function LineField({
  name,
  label,
  initial,
  required,
}: {
  name: string;
  label: string;
  initial?: string[];
  required?: boolean;
}) {
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="type-label">{label}</span>
      <textarea
        className="ui-input min-h-20 w-full"
        name={name}
        rows={2}
        maxLength={3900}
        required={required}
        defaultValue={initial?.join("\n")}
      />
      <span className="block text-xs text-muted">
        {required ? "One per line." : "One per line. Leave blank for any."}
      </span>
    </label>
  );
}

function assignmentFor(
  value: string,
  setup: AutomationSetupOptions | null,
  initial?: FactoryAutomationDefinition,
) {
  if (value === "saved" && initial) {
    const { target, executionGrant, servicePrincipalId, budgetPayerMemberId, credentialBindingId } =
      initial;
    return { target, executionGrant, servicePrincipalId, budgetPayerMemberId, credentialBindingId };
  }
  const assignment = setup?.assignment;
  if (!assignment) return null;
  const {
    definitionRevisionId,
    agentId,
    executionGrant,
    servicePrincipalId,
    budgetPayerMemberId,
    credentialBindingId,
  } = assignment;
  const workflow = setup.workflows.find(({ id }) => id === value);
  if (value !== "agent" && !workflow) return null;
  const target = workflow
    ? ({
        kind: "workflow",
        definitionRevisionId,
        agentId,
        workflowId: workflow.id,
        workflowActivationId: workflow.activationId,
      } as const)
    : ({ kind: "agent", definitionRevisionId, agentId } as const);
  return { target, executionGrant, servicePrincipalId, budgetPayerMemberId, credentialBindingId };
}

export function readAutomationDraft(
  form: HTMLFormElement,
  setup: AutomationSetupOptions | null,
  initial?: FactoryAutomationDefinition,
) {
  const fields = new FormData(form);
  const get = (name: string) => String(fields.get(name) ?? "").trim();
  const list = (name: string) =>
    get(name)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const assignment = assignmentFor(get("assignment"), setup, initial);
  const kind = get("trigger");
  const shared = { name: get("ruleName"), ...assignment };
  switch (kind) {
    case "schedule": {
      const [hour, minute] = get("localTime").split(":");
      const cadence = get("cadence");
      const cron =
        cadence === "hourly"
          ? "0 * * * *"
          : cadence === "custom"
            ? get("cron")
            : `${Number(minute)} ${Number(hour)} * * ${cadence === "weekdays" ? "1-5" : "*"}`;
      return factoryAutomationDefinitionSchema.safeParse({
        ...shared,
        trigger: { kind, cron, timeZone: get("timeZone") },
        filters: {},
      });
    }
    case "pull-request":
      return factoryAutomationDefinitionSchema.safeParse({
        ...shared,
        trigger: { kind, repositoryId: get("repositoryId") },
        filters: { actions: fields.getAll("actions"), baseBranches: list("baseBranches") },
      });
    default:
      return factoryAutomationDefinitionSchema.safeParse({
        ...shared,
        trigger: { kind },
        filters: {
          stateIds: list("stateIds"),
          teamIds: list("teamIds"),
          projectIds: list("projectIds"),
        },
      });
  }
}

export function AutomationEditorFields({
  initial,
  setup,
  disabled,
  changed,
}: {
  initial?: FactoryAutomationDefinition;
  setup: AutomationSetupOptions | null;
  disabled: boolean;
  changed: () => void;
}) {
  const [kind, setKind] = useState<AutomationTriggerKind>(initial?.trigger.kind ?? "schedule");
  const repositories =
    setup?.repositories.map(({ id, name }) => ({ value: id, label: name })) ?? [];
  const trigger = initial?.trigger;
  const filters = initial?.filters;
  const schedule = trigger?.kind === "schedule" ? trigger : undefined;
  const pullRequest = filters && "actions" in filters ? filters : undefined;
  const linear = filters && "stateIds" in filters ? filters : undefined;
  const savedRepository = trigger?.kind === "pull-request" ? trigger.repositoryId : undefined;
  if (savedRepository && !repositories.some(({ value }) => value === savedRepository)) {
    repositories.push({ value: savedRepository, label: "Previously selected repository" });
  }
  const selectedAssignment = setup?.assignment;
  const activeTarget =
    initial?.target.kind === "workflow"
      ? setup?.workflows.find(
          ({ id, activationId }) =>
            initial.target.kind === "workflow" &&
            initial.target.workflowId === id &&
            initial.target.workflowActivationId === activationId,
        )
      : undefined;
  const assignmentMatches =
    selectedAssignment &&
    initial?.target.definitionRevisionId === selectedAssignment.definitionRevisionId &&
    initial.target.agentId === selectedAssignment.agentId &&
    initial.executionGrant.id === selectedAssignment.executionGrant.id &&
    initial.executionGrant.version === selectedAssignment.executionGrant.version &&
    initial.servicePrincipalId === selectedAssignment.servicePrincipalId &&
    initial.budgetPayerMemberId === selectedAssignment.budgetPayerMemberId &&
    initial.credentialBindingId === selectedAssignment.credentialBindingId;
  const matchesCurrent = assignmentMatches && (initial.target.kind === "agent" || activeTarget);
  const assignments = [
    ...(initial && !matchesCurrent
      ? [{ value: "saved", label: "Previously assigned target" }]
      : []),
    ...(selectedAssignment
      ? [{ value: "agent", label: `Agent: ${selectedAssignment.agentName}` }]
      : []),
    ...(setup?.workflows.map(({ id, name }) => ({ value: id, label: `Workflow: ${name}` })) ?? []),
  ];

  return (
    <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2" disabled={disabled}>
      <legend className="sr-only">Automation rule fields</legend>
      <label className="block min-w-0 space-y-1.5">
        <span className="type-label">Rule name</span>
        <input
          className="ui-input"
          maxLength={120}
          name="ruleName"
          required
          defaultValue={initial?.name}
        />
      </label>
      <SelectField
        name="trigger"
        label="Trigger"
        required
        disabled={disabled}
        options={triggerOptions}
        value={kind}
        onValueChange={(value) => {
          setKind(automationTriggerKindSchema.parse(value));
          changed();
        }}
        wrap
      />
      {kind === "schedule" ? (
        <ScheduleFields initial={schedule} changed={changed} disabled={disabled} />
      ) : null}
      {kind === "pull-request" ? (
        <>
          <SelectField
            name="repositoryId"
            label="Trigger repository"
            required
            disabled={disabled}
            options={repositories}
            defaultValue={savedRepository}
            fallbackLabel="No repositories available"
            onValueChange={changed}
            wrap
          />
          <LineField
            name="baseBranches"
            label="Base branches"
            initial={pullRequest?.baseBranches}
          />
          <fieldset className="min-w-0 space-y-2 sm:col-span-2">
            <legend className="type-label">Pull request actions</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {automationPullRequestActionOptions.map(({ value, label }) => (
                <label className="inline-flex items-center gap-2 text-sm" key={value}>
                  <input
                    name="actions"
                    type="checkbox"
                    value={value}
                    defaultChecked={pullRequest?.actions.includes(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted">Leave all unchecked for any action.</p>
          </fieldset>
        </>
      ) : null}
      {kind === "issue-state" ? (
        <>
          <LineField name="stateIds" label="Linear state IDs" initial={linear?.stateIds} required />
          <LineField name="teamIds" label="Linear team IDs" initial={linear?.teamIds} />
          <LineField name="projectIds" label="Linear project IDs" initial={linear?.projectIds} />
        </>
      ) : null}
      <SelectField
        name="assignment"
        label="Assigned target"
        required
        disabled={disabled}
        options={assignments}
        defaultValue={
          matchesCurrent ? (activeTarget?.id ?? "agent") : initial ? "saved" : undefined
        }
        fallbackLabel="No approved target available"
        onValueChange={changed}
        wrap
      />
    </fieldset>
  );
}
