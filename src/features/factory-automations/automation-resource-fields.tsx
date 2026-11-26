"use client";

import { useId, useState } from "react";

import { SelectField } from "@/components/ui/select";
import { ResourceIdDetails } from "@/features/settings/connector-settings/catalog";

import {
  LinearChoiceStatus,
  linearOptionLabel,
  useAutomationLinearCatalog,
  type LinearKind,
} from "./automation-linear-catalog";

export const linearLabel = {
  state: "Linear state",
  team: "Linear team",
  project: "Linear project",
};

export function linearValueLabel(
  choices: ReturnType<typeof useAutomationLinearCatalog>,
  kind: LinearKind,
  value: string,
) {
  const known = choices[kind].known.find(({ id }) => id === value);
  return known ? linearOptionLabel(known) : `Saved Linear ${kind}`;
}

function retainedLabel(
  choices: ReturnType<typeof useAutomationLinearCatalog>,
  kind: LinearKind,
  value: string,
) {
  const label = linearValueLabel(choices, kind, value);
  const { catalog, options } = choices[kind];
  return options.some(({ id }) => id === value)
    ? label
    : `${label} · ${catalog?.loading ? "Checking availability" : "Unavailable in lookup"}`;
}

export function AutomationLinearFilter({
  kind,
  initial = [],
  disabled,
  changed,
}: {
  kind: LinearKind;
  initial?: string[];
  disabled: boolean;
  changed: () => void;
}) {
  const choices = useAutomationLinearCatalog();
  const guidance = useId();
  const [values, setValues] = useState(initial);
  const { catalog, options } = choices[kind];
  const canChange = Boolean(!disabled && catalog?.catalog && !catalog.loadFailed);
  const selectable = options.filter(({ id }) => !values.includes(id));

  function update(next: string[]) {
    setValues(next);
    changed();
  }

  return (
    <div className="min-w-0 space-y-2">
      {values.map((id, index) => (
        <div className="flex items-start justify-between gap-2 text-sm" key={id}>
          <span className="min-w-0 break-words">{retainedLabel(choices, kind, id)}</span>
          {canChange ? (
            <button
              aria-label={`Remove ${linearLabel[kind]} ${index + 1}: ${linearValueLabel(choices, kind, id)}`}
              className="ui-button shrink-0"
              onClick={() => update(values.filter((value) => value !== id))}
              type="button"
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <SelectField
        aria-describedby={guidance}
        label={`Add ${linearLabel[kind]}`}
        disabled={!canChange || !selectable.length || values.length >= 32}
        fallbackLabel={
          values.length >= 32
            ? "Maximum of 32 values"
            : kind === "state" || values.length > 0
              ? `Select a ${kind}`
              : `Any ${kind}`
        }
        options={selectable.map((option) => ({
          value: option.id,
          label: linearOptionLabel(option),
        }))}
        value=""
        onValueChange={(id) => {
          if (selectable.some((option) => option.id === id) && values.length < 32)
            update([...values, id]);
        }}
        wrap
      />
      <input name={`${kind}Ids`} type="hidden" value={values.join("\n")} />
      <p className="text-xs text-muted" id={guidance}>
        {kind === "state"
          ? "At least one state is required."
          : `Leave unselected to match any ${kind}.`}
      </p>
      <ResourceIdDetails ids={values} label="Technical ID" />
      <LinearChoiceStatus kind={kind} />
    </div>
  );
}

export function AutomationLinearSample({
  kind,
  initial,
  disabled,
  changed,
}: {
  kind: LinearKind;
  initial: string | null;
  disabled: boolean;
  changed: () => void;
}) {
  const choices = useAutomationLinearCatalog();
  const [value, setValue] = useState(initial ?? "");
  const { catalog, options } = choices[kind];
  const required = kind === "state";
  const selected =
    value && !options.some(({ id }) => id === value)
      ? [{ value, label: retainedLabel(choices, kind, value) }]
      : [];
  return (
    <div className="min-w-0 space-y-2">
      <SelectField
        label={kind === "state" ? "Issue state" : `Sample ${kind}`}
        disabled={disabled || !catalog?.catalog || catalog.loadFailed}
        emptyOption={required ? undefined : { value: "", label: `No ${kind}` }}
        fallbackLabel={required ? "Select a state" : `No ${kind}`}
        options={[
          ...selected,
          ...options.map((option) => ({ value: option.id, label: linearOptionLabel(option) })),
        ]}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          changed();
        }}
        wrap
      />
      <input name={`${kind}Id`} type="hidden" value={value} />
      <ResourceIdDetails ids={value ? [value] : []} label="Technical ID" />
      <LinearChoiceStatus kind={kind} />
    </div>
  );
}

export function AutomationRepositoryField({
  label,
  repositories,
  initial,
  savedName,
  disabled,
  changed,
}: {
  label: string;
  repositories: { id: string; name: string }[];
  initial?: string;
  savedName?: string | null;
  disabled: boolean;
  changed: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const unavailable = initial && !repositories.some(({ id }) => id === initial);
  return (
    <div className="min-w-0 space-y-2">
      <SelectField
        name="repositoryId"
        label={label}
        required
        disabled={disabled}
        options={[
          ...(unavailable
            ? [
                {
                  value: initial,
                  label: `${savedName ?? "Previously selected repository"} · Unavailable`,
                  disabled: value !== initial,
                },
              ]
            : []),
          ...repositories.map(({ id, name }) => ({ value: id, label: name })),
        ]}
        value={value}
        fallbackLabel={repositories.length ? "Select a repository" : "No repositories available"}
        onValueChange={(next) => {
          setValue(next);
          changed();
        }}
        wrap
      />
      <ResourceIdDetails ids={value ? [value] : []} label="Technical ID" />
    </div>
  );
}
