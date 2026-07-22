"use client";

import { useEffect, useMemo, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

import { SearchIcon } from "@/components/shared/icons/search-icon";
import { XIcon } from "@/components/shared/icons/x-icon";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { SessionStageFacet } from "@/features/sessions/list/data";
import {
  buildSessionsListHref,
  SESSION_LIST_SORT_OPTIONS,
} from "@/features/sessions/list/sessions-list-mutations";
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

const STATUS_CHIPS: { key: SessionFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
];

const DEFAULT_QUERY_STATE: Pick<
  SessionListQueryState,
  "cursor" | "query" | "scope" | "sort" | "stageSlug"
> = {
  cursor: null,
  query: "",
  scope: "all",
  sort: "updated",
  stageSlug: null,
};

function hasActiveFilters(queryState: SessionListQueryState) {
  return (
    queryState.query.trim().length > 0 ||
    queryState.scope !== "all" ||
    queryState.stageSlug !== null ||
    queryState.sort !== "updated"
  );
}

export function SessionsCommandBar({
  queryState,
  stageFacets,
  workspaceSlug,
}: SessionsCommandBarProps) {
  const router = useRouter();
  const { startNavigation } = useOptionalRouteProgress();
  const [, startTransition] = useTransition();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const shouldRestoreSearchFocusRef = useRef(false);

  const basePath = workspaceSessionsPath(workspaceSlug);
  const clearEnabled = hasActiveFilters(queryState);

  useEffect(() => {
    if (!shouldRestoreSearchFocusRef.current) return;
    shouldRestoreSearchFocusRef.current = false;
    searchInputRef.current?.focus();
  }, [queryState.query]);

  function updateQueryState(next: Partial<SessionListQueryState>) {
    const merged: SessionListQueryState = {
      cursor: next.cursor !== undefined ? next.cursor : null,
      query: next.query !== undefined ? next.query : queryState.query,
      scope: next.scope !== undefined ? next.scope : queryState.scope,
      sort: next.sort !== undefined ? next.sort : queryState.sort,
      stageSlug: next.stageSlug !== undefined ? next.stageSlug : queryState.stageSlug,
    };
    const href = buildSessionsListHref(basePath, merged);
    startNavigation(href);
    startTransition(() => {
      router.push(href);
    });
  }

  function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = searchInputRef.current?.value ?? "";
    updateQueryState({ query: value });
  }

  function handleClear() {
    if (searchInputRef.current) searchInputRef.current.value = "";
    const willRemountSearch = Boolean(queryState.query);
    if (willRemountSearch) {
      shouldRestoreSearchFocusRef.current = true;
    }
    updateQueryState({ ...DEFAULT_QUERY_STATE });
    if (!willRemountSearch) {
      queueMicrotask(() => searchInputRef.current?.focus());
    }
  }

  const stageGroups = useMemo(() => {
    const order = [...stageFacets].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    const counts = new Map(order.map((stage) => [stage.slug, stage.count]));

    return { counts, order };
  }, [stageFacets]);

  const stageValueLabel = useMemo(() => {
    if (!queryState.stageSlug) return "All stages";
    return stageGroups.order.find((stage) => stage.slug === queryState.stageSlug)?.name ?? "Stage";
  }, [queryState.stageSlug, stageGroups.order]);

  const sortValueLabel =
    SESSION_LIST_SORT_OPTIONS.find((option) => option.key === queryState.sort)?.label ??
    "Recently updated";

  return (
    <div className="mb-6 border-y border-border py-2.5">
      <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap lg:gap-2.5">
        <form
          onSubmit={handleSearchSubmit}
          className="flex w-full shrink-0 items-center gap-1.5 sm:max-w-[300px] lg:w-[300px]"
          aria-label="Search sessions"
        >
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              key={queryState.query}
              ref={searchInputRef}
              id="sessions-search"
              type="search"
              defaultValue={queryState.query}
              placeholder="Search prompts, titles, or IDs"
              aria-label="Search prompts, titles, or Linear IDs"
              className="ui-input h-8 py-1.5 pl-8 pr-3 text-[13px]"
            />
          </div>
          <button type="submit" className="sr-only">
            Search
          </button>
        </form>

        <div
          role="group"
          aria-label="Status filter"
          className="inline-flex shrink-0 items-center gap-0 rounded-[6px] border border-border bg-sheet p-0.5"
        >
          {STATUS_CHIPS.map((chip) => {
            const isSelected = queryState.scope === chip.key;
            return (
              <button
                aria-pressed={isSelected}
                key={chip.key}
                type="button"
                onClick={() => updateQueryState({ scope: chip.key })}
                className={cn(
                  "inline-flex h-7 items-center justify-center rounded-[4px] px-2.5 text-xs font-medium transition-[background-color,color] duration-150",
                  isSelected
                    ? "bg-control-muted text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]"
                    : "text-muted hover:bg-control-hover hover:text-foreground",
                )}
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        <div aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-border lg:block" />

        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap lg:gap-2.5">
          <Select
            value={queryState.stageSlug ?? "__all__"}
            onValueChange={(nextValue) =>
              updateQueryState({
                stageSlug: nextValue === "__all__" ? null : nextValue,
              })
            }
          >
            <SelectTrigger
              accessibleLabel="Filter by stage"
              className="h-8 min-h-0 w-auto min-w-[8.5rem] max-w-[12rem] gap-1.5 px-2.5 text-[13px]"
            >
              <span className="truncate">{stageValueLabel}</span>
            </SelectTrigger>
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
            value={queryState.sort}
            onValueChange={(nextValue) =>
              updateQueryState({ sort: nextValue as SessionListSortKey })
            }
          >
            <SelectTrigger
              accessibleLabel="Sort sessions"
              className="h-8 min-h-0 w-auto min-w-[9rem] max-w-[12rem] gap-1.5 px-2.5 text-[13px]"
            >
              <span className="truncate">{sortValueLabel}</span>
            </SelectTrigger>
            <SelectContent>
              {SESSION_LIST_SORT_OPTIONS.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {clearEnabled ? (
            <button
              type="button"
              onClick={handleClear}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] border border-border bg-sheet px-2.5 text-[13px] font-medium text-muted transition-[background-color,color,border-color] duration-150 hover:border-border-strong hover:bg-control-hover hover:text-foreground"
            >
              <XIcon className="h-3.5 w-3.5" />
              <span>Clear</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
