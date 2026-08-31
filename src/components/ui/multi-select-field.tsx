"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

export type MultiSelectOption = {
  description?: string;
  label: string;
  value: string;
};

type MultiSelectFieldProps = {
  description: string;
  disabled?: boolean;
  emptyMessage: string;
  error?: string;
  id: string;
  label: string;
  onValuesChange: (values: string[]) => void;
  options: readonly MultiSelectOption[];
  summary: string;
  values: readonly string[];
};

export function MultiSelectField({
  description,
  disabled = false,
  emptyMessage,
  error,
  id,
  label,
  onValuesChange,
  options,
  summary,
  values,
}: MultiSelectFieldProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const labelId = `${id}-label`;
  const summaryId = `${id}-summary`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const optionsId = `${id}-options`;
  const describedBy = error ? `${descriptionId} ${errorId}` : descriptionId;

  function toggleValue(value: string) {
    onValuesChange(
      values.includes(value) ? values.filter((item) => item !== value) : [...values, value],
    );
  }

  return (
    <fieldset
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      className="min-w-0 space-y-1.5"
      disabled={disabled}
    >
      <legend className="text-[13px] font-medium text-foreground" id={labelId}>
        {label}
      </legend>
      <button
        aria-controls={optionsId}
        aria-describedby={describedBy}
        aria-expanded={isExpanded}
        aria-labelledby={`${labelId} ${summaryId}`}
        className={cn(
          "ui-input flex items-center justify-between gap-3 text-left",
          error && "border-danger",
        )}
        id={id}
        onClick={() => setIsExpanded((value) => !value)}
        type="button"
      >
        <span id={summaryId}>{summary}</span>
        <span aria-hidden="true" className="text-muted">
          {isExpanded ? "▾" : "▸"}
        </span>
      </button>
      <div
        className="max-h-48 overflow-y-auto rounded-[6px] border border-border bg-background p-2"
        hidden={!isExpanded}
        id={optionsId}
      >
        {options.length === 0 ? (
          <p className="text-xs text-muted">{emptyMessage}</p>
        ) : (
          <ul className="space-y-1">
            {options.map((option, optionIndex) => {
              const optionId = `${id}-option-${optionIndex}`;
              return (
                <li className="flex items-center gap-2 text-xs" key={option.value}>
                  <input
                    aria-label={`${option.label}${option.description ? ` (${option.description})` : ""}`}
                    checked={values.includes(option.value)}
                    id={optionId}
                    onChange={() => toggleValue(option.value)}
                    type="checkbox"
                  />
                  <label className="flex-1 cursor-pointer" htmlFor={optionId}>
                    <span className="font-medium text-foreground">{option.label}</span>
                    {option.description ? (
                      <span className="text-muted"> ({option.description})</span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="type-annotation text-muted" id={descriptionId}>
        {description}
      </p>
      {error ? (
        <p className="text-xs font-medium text-danger" id={errorId}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
