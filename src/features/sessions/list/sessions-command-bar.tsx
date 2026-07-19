"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { SearchIcon } from "@/components/shared/icons/search-icon";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { CommandBar } from "@/components/ui/page-shell";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import type { SessionListPageData } from "@/features/sessions/list/data";
import { buildSessionsListHref } from "@/features/sessions/list/sessions-list-mutations";
import { type SessionFilterKey, type SessionListQueryState } from "@/features/sessions/types";
import { workspaceSessionsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type SessionsCommandBarProps = {
  initialData: SessionListPageData;
};

const SCOPE_CHIPS: { key: SessionFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "has-pr", label: "Has PR" },
  { key: "archived", label: "Archived" },
];

export function SessionsCommandBar({ initialData }: SessionsCommandBarProps) {
  const router = useRouter();
  const { startNavigation } = useOptionalRouteProgress();
  const [isFilterPending, startTransition] = useTransition();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const shouldRestoreSearchFocusRef = useRef(false);
  const [filterPendingTarget, setFilterPendingTarget] = useState<string | null>(null);

  const workspaceSlug = initialData.workspace.slug;
  const basePath = workspaceSessionsPath(workspaceSlug);

  useEffect(() => {
    if (!shouldRestoreSearchFocusRef.current) return;
    shouldRestoreSearchFocusRef.current = false;
    searchInputRef.current?.focus();
  }, [initialData.queryState.query]);

  function updateQueryState(next: Partial<SessionListQueryState>, pendingTarget: string) {
    const merged: SessionListQueryState = {
      cursor: next.cursor !== undefined ? next.cursor : null,
      query: next.query !== undefined ? next.query : initialData.queryState.query,
      scope: next.scope !== undefined ? next.scope : initialData.queryState.scope,
      stageSlug: next.stageSlug !== undefined ? next.stageSlug : initialData.queryState.stageSlug,
    };
    const href = buildSessionsListHref(basePath, merged);
    setFilterPendingTarget(pendingTarget);
    startNavigation(href);
    startTransition(() => {
      router.replace(href);
    });
  }

  function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = searchInputRef.current?.value ?? "";
    updateQueryState({ query: value }, "search");
  }

  function handleSearchClear() {
    if (searchInputRef.current) searchInputRef.current.value = "";
    if (initialData.queryState.query) {
      shouldRestoreSearchFocusRef.current = true;
    } else {
      searchInputRef.current?.focus();
    }
    updateQueryState({ query: "" }, "clear");
  }

  const stageGroups = useMemo(() => {
    const order = [...initialData.stageFacets].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    const counts = new Map(order.map((stage) => [stage.slug, stage.count]));

    return { counts, order };
  }, [initialData.stageFacets]);

  return (
    <CommandBar className="mb-6">
      <form
        onSubmit={handleSearchSubmit}
        className="w-full flex-none space-y-1.5 sm:max-w-xl sm:flex-1 sm:min-w-[300px]"
      >
        <label className="text-[13px] font-medium text-foreground" htmlFor="sessions-search">
          Search sessions
        </label>
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              key={initialData.queryState.query}
              ref={searchInputRef}
              id="sessions-search"
              type="search"
              defaultValue={initialData.queryState.query}
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
          <button
            className="ui-button"
            disabled={isFilterPending && filterPendingTarget === "clear"}
            onClick={handleSearchClear}
            type="button"
          >
            <ActionButtonLabel
              idle="Clear"
              pending={isFilterPending && filterPendingTarget === "clear"}
              pendingLabel="Clearing…"
            />
          </button>
        </div>
      </form>

      <fieldset className="space-y-1.5">
        <legend className="text-[13px] font-medium text-foreground">Session scope</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {SCOPE_CHIPS.map((chip) => {
            const isSelected = initialData.queryState.scope === chip.key;
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
        <legend className="text-[13px] font-medium text-foreground">Pipeline stage</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            aria-pressed={initialData.queryState.stageSlug === null}
            type="button"
            className={cn(
              "ui-filter-chip",
              initialData.queryState.stageSlug === null && "ui-filter-chip-active",
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
            const isSelected = initialData.queryState.stageSlug === stage.slug;
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
    </CommandBar>
  );
}
