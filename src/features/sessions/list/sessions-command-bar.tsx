"use client";

import {
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useTransition,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";

import {
  FilterSearch,
  FilterSelectTrigger,
  ClearFilters,
  FILTER_BAR_CLASS,
  FILTER_SEARCH_CLASS,
} from "@/components/ui/filter-controls";
import { CommandBar } from "@/components/ui/page-shell";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import type { SessionScopeFacets, SessionStageFacet } from "@/features/sessions/list/data";
import {
  SESSION_LIST_SORT_OPTIONS,
  buildSessionsListHref,
} from "@/features/sessions/list/sessions-list-mutations";
import {
  readSessionListPreferences,
  writeSessionListPreferences,
} from "@/features/sessions/list/sessions-list-preferences";
import {
  SESSION_LIST_DEFAULT_FILTERS,
  areDefaultSessionListFilters,
  sessionListSearchHasStickyParams,
} from "@/features/sessions/list/sessions-list-query-state";
import {
  type SessionFilterKey,
  type SessionListQueryState,
  type SessionListSortKey,
} from "@/features/sessions/types";
import { workspaceSessionsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

export type SessionsCommandBarProps = {
  queryState: SessionListQueryState;
  scopeFacets: SessionScopeFacets;
  stageFacets: readonly SessionStageFacet[];
  workspaceSlug: string;
};

const SCOPE_OPTIONS: { key: SessionFilterKey; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
  { key: "all", label: "All" },
];

const DEFAULT_QUERY_STATE: Pick<
  SessionListQueryState,
  "cursor" | "query" | "scope" | "sort" | "stageSlug"
> = {
  cursor: null,
  query: "",
  ...SESSION_LIST_DEFAULT_FILTERS,
};

function hasActiveFilters(queryState: SessionListQueryState) {
  return queryState.query.trim().length > 0 || !areDefaultSessionListFilters(queryState);
}

export function SessionsCommandBar({
  queryState,
  scopeFacets,
  stageFacets,
  workspaceSlug,
}: SessionsCommandBarProps) {
  const router = useRouter();
  const { startNavigation } = useOptionalRouteProgress();
  const [isPending, startTransition] = useTransition();
  const [optimisticQuery, setOptimisticQuery] = useOptimistic(queryState);
  const latestQueryRef = useRef(queryState);
  const submittedSearchRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const basePath = workspaceSessionsPath(workspaceSlug);
  const clearEnabled = hasActiveFilters(optimisticQuery);

  useEffect(() => {
    if (!isPending) latestQueryRef.current = queryState;
  }, [isPending, queryState]);

  useEffect(() => {
    // Migrate legacy localStorage preferences for subsequent server requests.
    // Restoring them here would fetch the list twice on the first visit.
    const stored = readSessionListPreferences(workspaceSlug);
    if (stored) writeSessionListPreferences(workspaceSlug, stored);
  }, [workspaceSlug]);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    if (sessionListSearchHasStickyParams(search) || search.has("cursor")) return;
    if (areDefaultSessionListFilters(queryState)) return;

    // The server already fetched these filters. Only expose them in the URL;
    // router.replace would unnecessarily repeat the server render and query.
    const href = buildSessionsListHref(basePath, queryState, search);
    window.history.replaceState(null, "", href);
  }, [basePath, queryState]);

  useEffect(() => {
    const input = searchInputRef.current;
    if (input && (document.activeElement !== input || input.value === submittedSearchRef.current)) {
      input.value = queryState.query;
    }
  }, [queryState.query]);

  function updateQueryState(next: Partial<SessionListQueryState>) {
    const current = latestQueryRef.current;
    const merged: SessionListQueryState = {
      cursor: next.cursor !== undefined ? next.cursor : null,
      query: next.query !== undefined ? next.query : current.query,
      scope: next.scope !== undefined ? next.scope : current.scope,
      sort: next.sort !== undefined ? next.sort : current.sort,
      stageSlug: next.stageSlug !== undefined ? next.stageSlug : current.stageSlug,
    };
    latestQueryRef.current = merged;
    writeSessionListPreferences(workspaceSlug, {
      scope: merged.scope,
      sort: merged.sort,
      stageSlug: merged.stageSlug,
    });
    const href = buildSessionsListHref(basePath, merged);
    startNavigation(href);
    startTransition(() => {
      setOptimisticQuery(merged);
      router.push(href, { scroll: false });
    });
  }

  function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = searchInputRef.current?.value ?? "";
    submittedSearchRef.current = value;
    updateQueryState({ query: value });
  }

  function handleClear() {
    if (searchInputRef.current) searchInputRef.current.value = "";
    submittedSearchRef.current = "";
    updateQueryState({ ...DEFAULT_QUERY_STATE });
    searchInputRef.current?.focus();
  }

  function handleScopeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    if (!(event.target instanceof Element)) return;

    const radio = event.target.closest<HTMLElement>('[role="radio"]');
    if (!radio || !event.currentTarget.contains(radio)) return;

    event.preventDefault();
    const currentKey =
      (radio.dataset.sessionScope as SessionFilterKey | undefined) ?? optimisticQuery.scope;
    const currentIndex = SCOPE_OPTIONS.findIndex((option) => option.key === currentKey);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight")
      nextIndex = Math.min(currentIndex + 1, SCOPE_OPTIONS.length - 1);
    if (event.key === "ArrowLeft") nextIndex = Math.max(currentIndex - 1, 0);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = SCOPE_OPTIONS.length - 1;

    const next = SCOPE_OPTIONS[nextIndex];
    if (!next || next.key === currentKey) return;

    const group = event.currentTarget;
    updateQueryState({ scope: next.key });
    queueMicrotask(() => {
      group
        .querySelector<HTMLElement>(`[data-session-scope="${next.key}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  const stageGroups = useMemo(() => {
    const order = [...stageFacets].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    const counts = new Map(order.map((stage) => [stage.slug, stage.count]));

    return { counts, order };
  }, [stageFacets]);

  const stageValueLabel = useMemo(() => {
    if (!optimisticQuery.stageSlug) return "All stages";
    return (
      stageGroups.order.find((stage) => stage.slug === optimisticQuery.stageSlug)?.name ?? "Stage"
    );
  }, [optimisticQuery.stageSlug, stageGroups.order]);

  const sortValueLabel =
    SESSION_LIST_SORT_OPTIONS.find((option) => option.key === optimisticQuery.sort)?.label ??
    "Recently updated";

  return (
    <CommandBar
      aria-label="Sessions filters"
      className="sticky top-[var(--shell-scroll-padding)] z-10 -mx-4 mb-4 block border-0 border-b border-border bg-sheet/95 px-4 py-3 backdrop-blur-sm sm:-mx-8 sm:mb-6 sm:px-8"
    >
      <div
        aria-label="Session scope"
        className="mb-2 flex gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5"
        onKeyDown={handleScopeKeyDown}
        role="radiogroup"
      >
        {SCOPE_OPTIONS.map((option) => {
          const selected = optimisticQuery.scope === option.key;
          return (
            <button
              aria-checked={selected}
              aria-label={`${option.label} ${scopeFacets[option.key]}`}
              className={cn(
                "ui-filter-chip min-h-11 shrink-0 md:min-h-8",
                selected && "ui-filter-chip-active",
              )}
              data-session-scope={option.key}
              key={option.key}
              onClick={() => {
                updateQueryState({ scope: option.key });
              }}
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <span aria-hidden="true">{option.label}</span>
              <span
                aria-hidden="true"
                className="font-mono type-annotation tabular-nums text-muted"
              >
                {scopeFacets[option.key]}
              </span>
            </button>
          );
        })}
      </div>

      <div aria-busy={isPending} className={cn(FILTER_BAR_CLASS, "border-t-0 pt-2")}>
        <form
          onSubmit={handleSearchSubmit}
          className={cn("flex items-center", FILTER_SEARCH_CLASS)}
          aria-label="Search sessions"
        >
          <FilterSearch
            ref={searchInputRef}
            id="sessions-search"
            defaultValue={queryState.query}
            aria-label="Search prompts, titles, or Linear IDs"
            description="Search prompts, titles, session numbers, or Linear IDs. Press Enter to search."
          />
          <button type="submit" className="sr-only">
            Search
          </button>
        </form>

        <Select
          value={optimisticQuery.stageSlug ?? "__all__"}
          onValueChange={(nextValue) =>
            updateQueryState({
              stageSlug: nextValue === "__all__" ? null : nextValue,
            })
          }
        >
          <FilterSelectTrigger
            accessibleLabel="Filter by stage"
            className="min-w-[8.5rem] max-w-[12rem]"
          >
            <span className="truncate">{stageValueLabel}</span>
          </FilterSelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All stages</SelectItem>
            {stageGroups.order.map((stage) => {
              const count = stageGroups.counts.get(stage.slug) ?? 0;
              return (
                <SelectItem key={stage.slug} value={stage.slug}>
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="truncate">{stage.name}</span>
                    <span className="type-annotation shrink-0 text-muted">{count}</span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <Select
          value={optimisticQuery.sort}
          onValueChange={(nextValue) => updateQueryState({ sort: nextValue as SessionListSortKey })}
        >
          <FilterSelectTrigger
            accessibleLabel="Sort sessions"
            className="min-w-[9rem] max-w-[12rem]"
          >
            <span className="truncate">{sortValueLabel}</span>
          </FilterSelectTrigger>
          <SelectContent>
            {SESSION_LIST_SORT_OPTIONS.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {clearEnabled ? <ClearFilters onClick={handleClear} /> : null}
      </div>
      <div role="status" aria-live="polite" className="mt-2 min-h-4 text-xs text-muted">
        {isPending ? "Updating sessions…" : null}
      </div>
    </CommandBar>
  );
}
