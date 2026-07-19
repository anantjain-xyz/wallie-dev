"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { SearchIcon } from "@/components/shared/icons/search-icon";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { CommandBar } from "@/components/ui/page-shell";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { SelectField } from "@/components/ui/select";
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
  { key: "has-pr", label: "Has PR" },
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
  const [isFilterPending, startTransition] = useTransition();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const shouldRestoreSearchFocusRef = useRef(false);
  const [filterPendingTarget, setFilterPendingTarget] = useState<string | null>(null);

  const basePath = workspaceSessionsPath(workspaceSlug);
  const clearEnabled = hasActiveFilters(queryState);

  useEffect(() => {
    if (!shouldRestoreSearchFocusRef.current) return;
    shouldRestoreSearchFocusRef.current = false;
    searchInputRef.current?.focus();
  }, [queryState.query]);

  function updateQueryState(next: Partial<SessionListQueryState>, pendingTarget: string) {
    const merged: SessionListQueryState = {
      cursor: next.cursor !== undefined ? next.cursor : null,
      query: next.query !== undefined ? next.query : queryState.query,
      scope: next.scope !== undefined ? next.scope : queryState.scope,
      sort: next.sort !== undefined ? next.sort : queryState.sort,
      stageSlug: next.stageSlug !== undefined ? next.stageSlug : queryState.stageSlug,
    };
    const href = buildSessionsListHref(basePath, merged);
    setFilterPendingTarget(pendingTarget);
    startNavigation(href);
    startTransition(() => {
      // push (not replace) so share/refresh/back/forward keep filter history.
      router.push(href);
    });
  }

  function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = searchInputRef.current?.value ?? "";
    updateQueryState({ query: value }, "search");
  }

  function handleClear() {
    if (searchInputRef.current) searchInputRef.current.value = "";
    const willRemountSearch = Boolean(queryState.query);
    if (willRemountSearch) {
      shouldRestoreSearchFocusRef.current = true;
    }
    updateQueryState({ ...DEFAULT_QUERY_STATE }, "clear");
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

  return (
    <CommandBar className="mb-6">
      <form
        onSubmit={handleSearchSubmit}
        className="w-full flex-none space-y-1.5 sm:max-w-xl sm:flex-1 sm:min-w-[300px]"
      >
        <label className="text-[13px] font-medium text-foreground" htmlFor="sessions-search">
          Search
        </label>
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              key={queryState.query}
              ref={searchInputRef}
              id="sessions-search"
              type="search"
              defaultValue={queryState.query}
              placeholder="Prompts, titles, or Linear IDs"
              className="ui-input pl-8"
            />
          </div>
          <button
            className="ui-button-primary"
            disabled={isFilterPending && filterPendingTarget === "search"}
            type="submit"
          >
            <ActionButtonLabel
              idle="Search"
              pending={isFilterPending && filterPendingTarget === "search"}
              pendingLabel="Searching…"
            />
          </button>
        </div>
      </form>

      <fieldset className="space-y-1.5">
        <legend className="text-[13px] font-medium text-foreground">Status</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_CHIPS.map((chip) => {
            const isSelected = queryState.scope === chip.key;
            return (
              <button
                aria-pressed={isSelected}
                key={chip.key}
                type="button"
                className={cn("ui-filter-chip", isSelected && "ui-filter-chip-active")}
                disabled={isFilterPending && filterPendingTarget === `scope:${chip.key}`}
                onClick={() => updateQueryState({ scope: chip.key }, `scope:${chip.key}`)}
              >
                <ActionButtonLabel
                  idle={chip.label}
                  pending={isFilterPending && filterPendingTarget === `scope:${chip.key}`}
                  pendingLabel={`Loading ${chip.label}…`}
                />
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="text-[13px] font-medium text-foreground">Stage</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            aria-pressed={queryState.stageSlug === null}
            type="button"
            className={cn(
              "ui-filter-chip",
              queryState.stageSlug === null && "ui-filter-chip-active",
            )}
            disabled={isFilterPending && filterPendingTarget === "stage:all"}
            onClick={() => updateQueryState({ stageSlug: null }, "stage:all")}
          >
            <ActionButtonLabel
              idle="All stages"
              pending={isFilterPending && filterPendingTarget === "stage:all"}
              pendingLabel="Loading stages…"
            />
          </button>
          {stageGroups.order.map((stage) => {
            const isSelected = queryState.stageSlug === stage.slug;
            const count = stageGroups.counts.get(stage.slug) ?? 0;
            return (
              <button
                aria-label={`${stage.name}, ${count} ${count === 1 ? "session" : "sessions"}`}
                aria-pressed={isSelected}
                key={stage.slug}
                type="button"
                className={cn("ui-filter-chip", isSelected && "ui-filter-chip-active")}
                disabled={isFilterPending && filterPendingTarget === `stage:${stage.slug}`}
                onClick={() => updateQueryState({ stageSlug: stage.slug }, `stage:${stage.slug}`)}
              >
                <ActionButtonLabel
                  idle={stage.name}
                  pending={isFilterPending && filterPendingTarget === `stage:${stage.slug}`}
                  pendingLabel={`Loading ${stage.name}…`}
                />
                <span className="ml-1 type-annotation text-muted">{count}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <SelectField
        className="w-full min-w-[11rem] sm:w-auto sm:min-w-[14rem]"
        disabled={isFilterPending && filterPendingTarget === "sort"}
        label="Sort"
        onValueChange={(value) => updateQueryState({ sort: value as SessionListSortKey }, "sort")}
        options={SESSION_LIST_SORT_OPTIONS.map((option) => ({
          label: option.label,
          value: option.key,
        }))}
        value={queryState.sort}
      />

      <div className="space-y-1.5">
        <span className="text-[13px] font-medium text-foreground">Clear</span>
        <div>
          <button
            className="ui-button"
            disabled={!clearEnabled || (isFilterPending && filterPendingTarget === "clear")}
            onClick={handleClear}
            type="button"
          >
            <ActionButtonLabel
              idle="Clear filters"
              pending={isFilterPending && filterPendingTarget === "clear"}
              pendingLabel="Clearing…"
            />
          </button>
        </div>
      </div>
    </CommandBar>
  );
}
