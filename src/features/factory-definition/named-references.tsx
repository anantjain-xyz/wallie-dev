"use client";

import { useEffect, useRef, useState } from "react";

import { SelectField } from "@/components/ui/select";
import {
  namedReferencesResponseSchema,
  referenceKind,
  type NamedReference,
  type NamedReferencesRequest,
  type ReferenceKind,
} from "@/lib/factory-definitions/named-reference-contracts";

import { factoryEditorPost, fetchFactoryEditor } from "./editor-requests";

type Groups = Awaited<ReturnType<typeof requestReferences>>["groups"];

function requestReferences(url: string, body: NamedReferencesRequest, signal?: AbortSignal) {
  return fetchFactoryEditor(url, namedReferencesResponseSchema, {
    ...factoryEditorPost(body),
    signal,
  });
}

function mergeOptions(...pages: readonly (readonly NamedReference[])[]) {
  return [...new Map(pages.flat().map((choice) => [choice.id, choice] as const)).values()];
}

export function useNamedReferences(url: string | null, pinKey: string) {
  const [pages, setPages] = useState<Groups>({});
  const [pins, setPins] = useState<Groups>({});
  const [failed, setFailed] = useState(false);
  const [pinsFailed, setPinsFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [more, setMore] = useState<ReferenceKind | null>(null);
  const paging = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void requestReferences(url, { mode: "initial" }, controller.signal).then(
      ({ groups }) => {
        if (!controller.signal.aborted) {
          setPages(groups);
          setFailed(false);
        }
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => {
      controller.abort();
      paging.current?.abort();
    };
  }, [url, retry]);

  useEffect(() => {
    if (!url || pinKey === "{}") return;
    const controller = new AbortController();
    const ids = JSON.parse(pinKey) as Extract<NamedReferencesRequest, { mode: "pins" }>["ids"];
    void requestReferences(url, { mode: "pins", ids }, controller.signal).then(
      ({ groups }) => {
        if (!controller.signal.aborted) {
          setPins(groups);
          setPinsFailed(false);
        }
      },
      () => {
        if (!controller.signal.aborted) setPinsFailed(true);
      },
    );
    return () => controller.abort();
  }, [url, pinKey, retry]);

  function loadMore(kind: ReferenceKind) {
    const offset = pages[kind]?.next;
    if (!url || !offset || paging.current) return;
    const controller = new AbortController();
    paging.current = controller;
    setMore(kind);
    void requestReferences(url, { mode: "more", kind, offset }, controller.signal)
      .then(
        ({ groups }) => {
          const group = groups[kind];
          if (!controller.signal.aborted && group) {
            setPages((current) => ({
              ...current,
              [kind]: {
                ...group,
                options: mergeOptions(current[kind]?.options ?? [], group.options),
              },
            }));
            setFailed(false);
          }
        },
        () => {
          if (!controller.signal.aborted) setFailed(true);
        },
      )
      .finally(() => {
        if (paging.current === controller) {
          paging.current = null;
          setMore(null);
        }
      });
  }

  const options: Partial<Record<ReferenceKind, NamedReference[]>> = {};
  for (const kind of referenceKind.options) {
    if (pages[kind] || pins[kind])
      options[kind] = mergeOptions(pages[kind]?.options ?? [], pins[kind]?.options ?? []);
  }
  return {
    options,
    loadMore,
    hasMore: (kind: ReferenceKind) => Boolean(pages[kind]?.next),
    pending: more,
    loading: Boolean(url && !failed && !pages.pipeline),
    failed: failed || pinsFailed,
    retry: () => setRetry((value) => value + 1),
  };
}

export type ReferencePickerCatalog = Pick<
  ReturnType<typeof useNamedReferences>,
  "options" | "loadMore" | "hasMore" | "pending"
>;

export function findReference(options: readonly NamedReference[], id: string) {
  const exact = options.find((option) => option.id === id);
  if (exact) return exact;
  const aliases = options.filter((option) => option.aliases?.includes(id));
  return aliases.length === 1 ? aliases[0] : undefined;
}

export function displayedReference(option: NamedReference | undefined, fallback: string) {
  return option ? option.label + (option.unavailable ? " · Unavailable" : "") : fallback;
}

export function ReferencePicker({
  catalog,
  kind,
  id,
  label,
  options,
  value,
  onChange,
  empty,
  unavailable,
  disabled,
  selectedAllowed = true,
}: {
  catalog?: ReferencePickerCatalog;
  kind?: ReferenceKind;
  id?: string;
  label: string;
  options: readonly NamedReference[];
  value: string;
  onChange: (value: string) => void;
  empty: string;
  unavailable: string;
  disabled?: boolean;
  selectedAllowed?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const selected = findReference(options, value);
  const canLoadMore = kind && catalog?.hasMore(kind);
  const choices = options.filter(
    (option) =>
      !option.unavailable &&
      (option.id !== value || selectedAllowed) &&
      option.label.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  const selectedLabel = displayedReference(selected, unavailable);
  return (
    <div className="min-w-0 space-y-2">
      {options.length > 8 || canLoadMore || filter ? (
        <label className="block space-y-1">
          <span className="type-annotation text-muted">Filter {label.toLocaleLowerCase()}</span>
          <input
            className="ui-input"
            disabled={disabled}
            onChange={(event) => setFilter(event.target.value)}
            type="search"
            value={filter}
          />
        </label>
      ) : null}
      <SelectField
        id={id}
        label={label}
        disabled={disabled}
        emptyOption={{ label: empty, value: "" }}
        options={[
          ...(value && !choices.some(({ id }) => id === value)
            ? [
                {
                  value,
                  label: selectedAllowed ? selectedLabel : `${selectedLabel} · Not eligible`,
                  disabled: true,
                },
              ]
            : []),
          ...choices.map(({ id, label }) => ({ value: id, label })),
        ]}
        value={value}
        onValueChange={(id) => {
          onChange(id);
          setFilter("");
        }}
        wrap
      />
      {filter && !choices.length ? (
        <p className="type-annotation text-muted" role="status">
          No matches in loaded choices.
        </p>
      ) : null}
      {kind && catalog && canLoadMore ? (
        <button
          className="ui-button"
          disabled={disabled || Boolean(catalog.pending)}
          onClick={() => catalog.loadMore(kind)}
          type="button"
        >
          {catalog.pending === kind ? "Loading choices…" : `Show more: ${label}`}
        </button>
      ) : null}
    </div>
  );
}

export function ReferenceDetails({ value }: { value: string }) {
  return (
    <details className="min-w-0 text-xs text-muted">
      <summary className="cursor-pointer">Technical reference</summary>
      <code className="[overflow-wrap:anywhere]">{value}</code>
    </details>
  );
}

export function ReferenceSelectionList({
  catalog,
  kind,
  options,
  values,
  onChange,
  label,
  addLabel,
  unavailable,
  empty,
  id,
  disabled,
  limit,
}: {
  catalog?: ReferencePickerCatalog;
  kind: ReferenceKind;
  options: readonly NamedReference[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  label: string;
  addLabel: string;
  unavailable: string;
  empty: string;
  id?: string;
  disabled?: boolean;
  limit: number;
}) {
  return (
    <div className="min-w-0 space-y-2">
      {values.length ? (
        <ul aria-label={label} className="divide-y divide-border rounded-md border border-border">
          {values.map((value, index) => {
            const name = displayedReference(findReference(options, value), unavailable);
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                key={`${value}:${index}`}
              >
                <div className="min-w-0 text-sm [overflow-wrap:anywhere]">
                  {name}
                  <ReferenceDetails value={value} />
                </div>
                <button
                  aria-label={`Remove ${name}`}
                  className="ui-button"
                  disabled={disabled}
                  onClick={() => onChange(values.filter((_, position) => position !== index))}
                  type="button"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="type-secondary text-muted">{empty}</p>
      )}
      <ReferencePicker
        catalog={catalog}
        kind={kind}
        id={id}
        label={addLabel}
        options={options.filter(({ id }) => !values.includes(id))}
        value=""
        onChange={(id) => {
          if (id) onChange([...values, id]);
        }}
        disabled={disabled || values.length >= limit}
        empty="Choose a revision"
        unavailable={unavailable}
      />
      {values.length >= limit ? (
        <p className="type-annotation text-muted">Up to {limit} revisions can be selected.</p>
      ) : null}
    </div>
  );
}
