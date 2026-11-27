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
  FilterSelectTrigger,
  ClearFilters,
  FILTER_BAR_CLASS,
} from "@/components/ui/filter-controls";
import { CommandBar } from "@/components/ui/page-shell";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { resolveStatusDefinition } from "@/components/ui/status";
import {
  SessionsSearchForm,
  useSessionsSearchDraft,
} from "@/features/sessions/components/sessions-search-form";
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
  SESSION_LIST_STATUS_OPTIONS,
  areDefaultSessionListFilters,
  sessionListSearchHasStickyParams,
} from "@/features/sessions/list/sessions-list-query-state";
import {
  type SessionFilterKey,
  type SessionListQueryState,
  type SessionListSortKey,
} from "@/features/sessions/types";
import { workspaceSessionsPath } from "@/lib/routes";
import { withFactoryQuery } from "@/features/factories/factory-selection";
import { cn } from "@/lib/utils";
import { SESSION_SEARCH_RESUME_PARAM } from "@/lib/workspace-list-return-path";

export type SessionsCommandBarProps = {
  factoryQuery?: string;
  queryState: SessionListQueryState;
  scopeFacets: SessionScopeFacets;
  stageFacets: readonly SessionStageFacet[];
  workspaceSlug: string;
};

const SCOPE_OPTIONS: { key: SessionFilterKey; label: string }[] = [
  { key: "active", label: "Not archived" },
  { key: "archived", label: "Archived" },
  { key: "all", label: "All sessions" },
];

const DEFAULT_QUERY_STATE: SessionListQueryState = {
  cursor: null,
  query: "",
  status: undefined,
  ...SESSION_LIST_DEFAULT_FILTERS,
};

function hasActiveFilters(queryState: SessionListQueryState) {
  return queryState.query.trim().length > 0 || !areDefaultSessionListFilters(queryState);
}

export function SessionsCommandBar({
  factoryQuery,
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { search, setSearch } = useSessionsSearchDraft(queryState.query);

  const basePath = workspaceSessionsPath(workspaceSlug);
  const clearEnabled = !areDefaultSessionListFilters(optimisticQuery);
  const aggregate = factoryQuery === "all";
  const searchUnapplied = search.draft.trim() !== optimisticQuery.query.trim();
  const appliedSearchSummary = queryState.query.trim()
    ? `Results for “${queryState.query.trim()}”`
    : "";

  useEffect(() => {
    if (!isPending) latestQueryRef.current = queryState;
  }, [isPending, queryState]);

  useEffect(() => {
    if (factoryQuery !== undefined) return;
    // Migrate legacy localStorage preferences for subsequent server requests.
    // Restoring them here would fetch the list twice on the first visit.
    const stored = readSessionListPreferences(workspaceSlug);
    if (stored) writeSessionListPreferences(workspaceSlug, stored);
  }, [factoryQuery, workspaceSlug]);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    if (
      sessionListSearchHasStickyParams(search) ||
      search.has("cursor") ||
      search.has(SESSION_SEARCH_RESUME_PARAM)
    )
      return;
    if (areDefaultSessionListFilters(queryState)) return;

    // The server already fetched these filters. Only expose them in the URL;
    // router.replace would unnecessarily repeat the server render and query.
    const href = buildSessionsListHref(basePath, queryState, search);
    window.history.replaceState(null, "", href);
  }, [basePath, queryState]);

  function updateQueryState(next: Partial<SessionListQueryState>) {
    const current = latestQueryRef.current;
    const merged: SessionListQueryState = {
      cursor: next.cursor !== undefined ? next.cursor : null,
      query: next.query !== undefined ? next.query : current.query,
      scope: next.scope !== undefined ? next.scope : current.scope,
      sort: next.sort !== undefined ? next.sort : current.sort,
      stageSlug: next.stageSlug !== undefined ? next.stageSlug : current.stageSlug,
      status: "status" in next ? next.status : current.status,
    };
    latestQueryRef.current = merged;
    if (factoryQuery === undefined) {
      writeSessionListPreferences(workspaceSlug, {
        scope: merged.scope,
        sort: merged.sort,
        stageSlug: merged.stageSlug,
      });
    }
    const href = withFactoryQuery(buildSessionsListHref(basePath, merged), factoryQuery);
    startNavigation(href);
    startTransition(() => {
      setOptimisticQuery(merged);
      router.push(href, { scroll: false });
    });
  }

  function handleSearchSubmit(value: string) {
    if (isPending || value === latestQueryRef.current.query.trim()) return;
    setSearch({ ...search, submitted: value });
    updateQueryState({ query: value });
  }

  function handleClearSearch() {
    const needsNavigation = Boolean(latestQueryRef.current.query.trim());
    setSearch({ ...search, draft: "", submitted: needsNavigation ? "" : null });
    if (needsNavigation) updateQueryState({ query: "" });
    searchInputRef.current?.focus();
  }

  function handleClear() {
    const needsNavigation = hasActiveFilters(latestQueryRef.current);
    setSearch({ ...search, draft: "", submitted: needsNavigation ? "" : null });
    if (needsNavigation) updateQueryState({ ...DEFAULT_QUERY_STATE });
    searchInputRef.current?.focus();
  }

  function handleScopeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    if (!(event.target instanceof Element)) return;

    const radio = event.target.closest<HTMLElement>('[role="radio"]');
    if (!radio || !event.currentTarget.contains(radio)) return;

    event.preventDefault();
    const currentKey =
      (radio.dataset.sessionScope as SessionFilterKey | undefined) ?? optimisticQuery.scope;
    const currentIndex = SCOPE_OPTIONS.findIndex((option) => option.key === currentKey);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = Math.min(currentIndex + 1, SCOPE_OPTIONS.length - 1);
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = Math.max(currentIndex - 1, 0);
    }
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
    const order = [...stageFacets].sort((a, b) =>
      aggregate
        ? a.slug.localeCompare(b.slug)
        : a.position - b.position || a.name.localeCompare(b.name),
    );
    const counts = new Map(order.map((stage) => [stage.slug, stage.count]));

    return { counts, order };
  }, [aggregate, stageFacets]);

  const stageValueLabel = useMemo(() => {
    if (!optimisticQuery.stageSlug) return aggregate ? "All stage keys" : "All stages";
    if (aggregate) return `Stage key: ${optimisticQuery.stageSlug}`;
    return (
      stageGroups.order.find((stage) => stage.slug === optimisticQuery.stageSlug)?.name ??
      "Selected stage"
    );
  }, [aggregate, optimisticQuery.stageSlug, stageGroups.order]);

  const sortValueLabel =
    SESSION_LIST_SORT_OPTIONS.find((option) => option.key === optimisticQuery.sort)?.label ??
    "Recently updated";

  return (
    <CommandBar
      aria-label="Sessions filters"
      className="-mx-4 mb-4 block border-0 border-b border-border px-4 py-2 sm:-mx-8 sm:mb-6 sm:px-8 sm:py-3"
    >
      <div
        aria-label="Session scope"
        className="mb-1.5 flex gap-1 overflow-x-auto overscroll-x-contain pb-0.5"
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
                "ui-filter-chip h-9 min-h-9 shrink-0 px-2.5 md:h-8 md:min-h-8",
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

      <div
        aria-busy={isPending}
        className={cn(FILTER_BAR_CLASS, "items-stretch gap-1.5 border-t-0 py-1.5 sm:items-end")}
      >
        <SessionsSearchForm
          accessibleLabel="Search sessions by title, prompt, session number, or Linear issue key"
          appliedQuery={queryState.query}
          description="For example: session #42 or Linear issue OP-517."
          draft={search.draft}
          inputId="sessions-search"
          inputRef={searchInputRef}
          onClear={handleClearSearch}
          onDraftChange={(draft) => setSearch({ ...search, draft })}
          onSearch={handleSearchSubmit}
          pending={isPending}
          placeholder="Title, prompt, #, or Linear key…"
          showClear={Boolean(search.draft || optimisticQuery.query)}
        />

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Select
            value={optimisticQuery.stageSlug ?? "__all__"}
            onValueChange={(nextValue) =>
              updateQueryState({
                stageSlug: nextValue === "__all__" ? null : nextValue,
              })
            }
          >
            <FilterSelectTrigger
              accessibleLabel={aggregate ? "Filter by stage key" : "Filter by stage"}
              className="h-9 min-h-9 min-w-0 max-w-[10rem] px-2 text-sm md:h-9 md:max-w-[12rem] md:text-[13px]"
            >
              <span className="truncate">{stageValueLabel}</span>
            </FilterSelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{aggregate ? "All stage keys" : "All stages"}</SelectItem>
              {stageGroups.order.map((stage) => {
                const count = stageGroups.counts.get(stage.slug) ?? 0;
                return (
                  <SelectItem key={stage.slug} value={stage.slug}>
                    <span className="flex w-full items-center justify-between gap-3">
                      <span className="min-w-0 break-words">
                        {aggregate ? stage.slug : stage.name}
                      </span>
                      <span className="type-annotation shrink-0 text-muted">{count}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          <Select
            value={optimisticQuery.status ?? "__all__"}
            onValueChange={(value) =>
              updateQueryState({
                status: SESSION_LIST_STATUS_OPTIONS.find((option) => option === value),
              })
            }
          >
            <FilterSelectTrigger
              accessibleLabel="Filter by status"
              className="h-9 min-h-9 min-w-0 max-w-[10rem] px-2 text-sm md:h-9 md:max-w-[12rem] md:text-[13px]"
            >
              <span className="truncate">
                {optimisticQuery.status
                  ? resolveStatusDefinition(optimisticQuery.status).label
                  : "All statuses"}
              </span>
            </FilterSelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              {SESSION_LIST_STATUS_OPTIONS.map((status) => (
                <SelectItem key={status} value={status}>
                  {resolveStatusDefinition(status).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={optimisticQuery.sort}
            onValueChange={(nextValue) =>
              updateQueryState({ sort: nextValue as SessionListSortKey })
            }
          >
            <FilterSelectTrigger
              accessibleLabel="Sort sessions"
              className="h-9 min-h-9 min-w-0 max-w-[10rem] px-2 text-sm md:h-9 md:max-w-[12rem] md:text-[13px]"
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

          {clearEnabled ? (
            <ClearFilters
              className="h-9 min-h-9 w-auto shrink-0 px-2 text-sm md:h-9 md:text-[13px]"
              onClick={handleClear}
            />
          ) : null}
        </div>
      </div>
      <div
        role="status"
        aria-label="Sessions search status"
        aria-live="polite"
        aria-atomic="true"
        className="mt-1 min-h-4 text-xs text-muted [overflow-wrap:anywhere]"
      >
        {isPending ? <span>{search.submitted !== null ? "Searching…" : "Updating…"} </span> : null}
        {searchUnapplied ? (
          <span className="font-medium text-foreground">
            {isPending ? "New edits not searched." : "Press Enter to search."}{" "}
          </span>
        ) : null}
        {!isPending ? <span>{appliedSearchSummary}</span> : null}
      </div>
    </CommandBar>
  );
}
