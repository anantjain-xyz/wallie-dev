"use client";

import { useEffect, useId, useState } from "react";

import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import type { RunSessionOption } from "./runs-list-options";

const anySession = { id: "", label: "Any session" };

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
  const [selection, setSelection] = useState(
    selectedId ? (selectedOption ?? { id: selectedId, label: "Session unavailable" }) : anySession,
  );
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{ query: string; options: RunSessionOption[] } | null>(null);
  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const query = search.trim();
  const options = result?.query === query ? [anySession, ...result.options] : [anySession];
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
          setActive(query && options.length ? 1 : 0);
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

  function close() {
    setOpen(false);
    setSearch("");
    setResult(null);
    setFailedQuery(null);
    setActive(0);
  }

  function choose(option: RunSessionOption) {
    setSelection(option);
    close();
  }

  function activate(index: number) {
    const next = (index + options.length) % options.length;
    setActive(next);
    document.getElementById(`${id}-${next}`)?.scrollIntoView?.({ block: "nearest" });
  }

  return (
    <div className="relative min-w-0 flex-1 basis-48 space-y-1">
      <label className="block text-xs text-muted" htmlFor={id}>
        Session
      </label>
      <input name="sessionId" type="hidden" value={selection.id} />
      <input
        aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls={open ? `${id}-options` : undefined}
        aria-expanded={open}
        autoComplete="off"
        className={`ui-input w-full ${FILTER_CONTROL_CLASS}`}
        id={id}
        maxLength={open ? 120 : undefined}
        onBlur={close}
        onChange={(event) => {
          setSearch(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpen(true);
            else activate(active + (event.key === "ArrowDown" ? 1 : -1));
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (!query || (!loading && !failed && active > 0)) {
              const option = options[active];
              if (option) choose(option);
            }
          }
        }}
        placeholder={open ? "Search by title or #number…" : undefined}
        role="combobox"
        type="text"
        value={open ? search : selection.label}
      />
      {open ? (
        <div className="absolute inset-x-0 top-full z-20 rounded-md border border-border bg-sheet shadow-lg">
          <ul
            aria-label="Session matches"
            className="max-h-56 overflow-y-auto p-1"
            id={`${id}-options`}
            role="listbox"
          >
            {options.map((option, index) => (
              <li
                aria-selected={index === active}
                className="cursor-pointer rounded px-2 py-2 text-sm break-words hover:bg-control-muted aria-selected:bg-control-muted"
                id={`${id}-${index}`}
                key={option.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                role="option"
              >
                <span>{option.label}</span>
                {option.factoryName ? (
                  <span className="block text-xs text-muted">{option.factoryName}</span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="px-3 pb-2 text-xs text-muted empty:hidden" role="status">
            {failed
              ? "Couldn’t load sessions. Reopen the search to try again."
              : loading
                ? "Searching sessions…"
                : options.length === 1
                  ? "No matching sessions."
                  : "Search by title or session number to narrow the list."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
