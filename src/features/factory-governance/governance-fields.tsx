"use client";

import { useId, useState, type ComponentProps } from "react";

import { SelectField } from "@/components/ui/select";

export type GovernanceChoice = { id: string; label: string };

export function matchesGovernanceSearch(label: string, search: string) {
  return search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => label.toLowerCase().includes(word));
}

export function GovernanceSelect({
  choices,
  search,
  ...props
}: Omit<ComponentProps<typeof SelectField>, "options" | "label"> & {
  choices: GovernanceChoice[];
  label: string;
  search?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const active = props.value ?? props.defaultValue;
  const options = choices.filter(
    ({ id, label }) => id === active || matchesGovernanceSearch(label, filter),
  );
  return (
    <div className="min-w-0 space-y-2">
      {search && choices.length > 8 && (
        <label className="block space-y-1">
          <span className="type-secondary text-muted">
            Filter {props.label.toLowerCase()} options
          </span>
          <input
            className="ui-input"
            onChange={(event) => setFilter(event.currentTarget.value)}
            type="search"
            value={filter}
          />
        </label>
      )}
      <SelectField {...props} options={options.map(({ id, label }) => ({ label, value: id }))} />
      {filter.trim() && !choices.some(({ label }) => matchesGovernanceSearch(label, filter)) && (
        <p className="type-secondary text-muted" role="status">
          No matching options.
        </p>
      )}
    </div>
  );
}

export function CopyGovernanceId({ label, value }: { label: string; value: string }) {
  const field = useId();
  const [feedback, setFeedback] = useState("");
  const object = label.charAt(0).toLowerCase() + label.slice(1);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(`${label} copied.`);
    } catch {
      setFeedback(`Select and copy the ${object} manually.`);
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <code className="select-all [overflow-wrap:anywhere]" id={field}>
        {value}
      </code>
      <button
        aria-describedby={field}
        className="ui-button"
        onClick={() => void copy()}
        type="button"
      >
        Copy {object}
      </button>
      <span className="type-secondary text-muted" role="status">
        {feedback}
      </span>
    </div>
  );
}
