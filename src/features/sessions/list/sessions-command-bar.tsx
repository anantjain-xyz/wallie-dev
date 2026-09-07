"use client";

import { useEffect, useMemo, useOptimistic, useRef, useTransition } from "react";
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
import type { SessionStageFacet } from "@/features/sessions/list/data";
import {
  SESSION_LIST_SORT_OPTIONS,
  buildSessionsListHref,
} from "@/features/sessions/list/sessions-list-mutations";
import {
  readSessionListPreferences,
  shouldRestoreSessionListPreferences,
  writeSessionListPreferences,
} from "@/features/sessions/list/sessions-list-preferences";
import {
  SESSION_LIST_DEFAULT_FILTERS,
  areDefaultSessionListFilters,
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
  stageFacets,
  workspaceSlug,
}: SessionsCommandBarProps) {
  const router = useRouter();
  const { startNavigation } = useOptionalRouteProgress();
  const [isPending, startTransition] = useTransition();
  const [optimisticQuery, setOptimisticQuery] = useOptimistic(queryState);
  const latestQueryRef = useRef(queryState);
  const restoreAttemptedRef = useRef(false);
  const submittedSearchRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const basePath = workspaceSessionsPath(workspaceSlug);
  const clearEnabled = hasActiveFilters(optimisticQuery);

  useEffect(() => {
    if (!isPending) latestQueryRef.current = queryState;
  }, [isPending, queryState]);

  useEffect(() => {
    if (restoreAttemptedRef.current) {
      return;
    }
    restoreAttemptedRef.current = true;

    const search = new URLSearchParams(window.location.search);
    const stored = readSessionListPreferences(workspaceSlug);
    if (!stored || !shouldRestoreSessionListPreferences({ queryState, search, stored })) {
      return;
    }

    const merged: SessionListQueryState = {
      cursor: null,
      query: queryState.query,
      scope: stored.scope,
      sort: stored.sort,
      stageSlug: stored.stageSlug,
    };
    latestQueryRef.current = merged;
    const href = buildSessionsListHref(basePath, merged, search);
    startNavigation(href);
    startTransition(() => {
      setOptimisticQuery(merged);
      router.replace(href, { scroll: false });
    });
  }, [basePath, queryState, router, setOptimisticQuery, startNavigation, workspaceSlug]);

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
    <CommandBar aria-label="Sessions filters" className="mb-6 block border-0 p-0">
      <div aria-busy={isPending} className={FILTER_BAR_CLASS}>
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
          value={optimisticQuery.scope}
          onValueChange={(value) => updateQueryState({ scope: value as SessionFilterKey })}
        >
          <FilterSelectTrigger accessibleLabel="Session scope">
            {SCOPE_OPTIONS.find((option) => option.key === optimisticQuery.scope)?.label}
          </FilterSelectTrigger>
          <SelectContent>
            {SCOPE_OPTIONS.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

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
