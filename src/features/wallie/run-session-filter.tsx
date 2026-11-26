"use client";

import { useEffect, useId, useState } from "react";

import { EditableCombobox, type EditableComboboxOption } from "@/components/ui/editable-combobox";
import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import type { RunSessionOption } from "./runs-list-options";

const anySession: EditableComboboxOption = { value: "", label: "Any session" };

export function RunSessionFilter({
  factory,
  selectedId,
  selectedOption,
  workspaceId,
}: {
  factory: string;
  selectedId?: string;
  selectedOption?: RunSessionOption | null;
  workspaceId: string;
}) {
  const id = useId();
  const [selection, setSelection] = useState<EditableComboboxOption>(
    selectedId
      ? { value: selectedId, label: selectedOption?.label ?? "Session unavailable" }
      : anySession,
  );
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ query: string; options: RunSessionOption[] } | null>(null);
  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const query = search.trim();
  const options =
    result?.query === query
      ? [
          anySession,
          ...result.options.map(({ id, label, factoryName }) => ({
            value: id,
            label,
            description: factoryName,
          })),
        ]
      : [anySession];
  const failed = failedQuery === query;
  const loading = !failed && result?.query !== query;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        try {
          const response = await fetch(
            `/api/workspaces/${workspaceId}/runs/session-options?${new URLSearchParams({ factory, q: query })}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) throw new Error("Session search unavailable.");
          const options: RunSessionOption[] = await response.json();
          if (controller.signal.aborted) return;
          setFailedQuery(null);
          setResult({ query, options });
        } catch {
          if (!controller.signal.aborted) {
            setResult(null);
            setFailedQuery(query);
          }
        }
      },
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [factory, open, query, workspaceId]);

  return (
    <div className="min-w-0 flex-1 basis-48 space-y-1">
      <label className="block text-xs text-muted" htmlFor={id}>
        Session
      </label>
      <input name="sessionId" type="hidden" value={selection.value} />
      <EditableCombobox
        className={FILTER_CONTROL_CLASS}
        defaultActiveValue={query ? options[1]?.value : anySession.value}
        id={id}
        listboxLabel="Session matches"
        maxLength={open ? 120 : undefined}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setSearch("");
            setResult(null);
            setFailedQuery(null);
          }
        }}
        onOptionSelect={setSelection}
        onValueChange={setSearch}
        open={open}
        options={options}
        placeholder={open ? "Search by title or #number…" : undefined}
        preventUnmatchedEnter
        selectedValue={selection.value}
        status={
          failed
            ? "Couldn’t load sessions. Reopen the search to try again."
            : loading
              ? "Searching sessions…"
              : options.length === 1
                ? "No matching sessions."
                : "Search by title or session number to narrow the list."
        }
        value={open ? search : selection.label}
      />
    </div>
  );
}
