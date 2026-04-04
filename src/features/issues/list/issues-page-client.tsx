"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  ChevronDownIcon,
  FilterIcon,
  IssueBarsIcon,
  LayoutIcon,
  PlusIcon,
  PriorityTriangleIcon,
  SearchIcon,
  SlidersIcon,
  StateCircleIcon,
  UsersIcon,
} from "@/components/shared/linear-icons";
import { updateIssueRows } from "@/features/issues/client";
import { CreateIssueDialog } from "@/features/issues/list/create-issue-dialog";
import type { IssueListPageData } from "@/features/issues/list/data";
import {
  type IssueListQueryState,
  mergeIssueListPreferences,
  serializeIssueListQueryState,
} from "@/features/issues/list/query-state";
import {
  formatIssuePriority,
  formatIssueStatus,
  getIssueMemberDisplayName,
  ISSUE_ESTIMATE_VALUES,
  ISSUE_PRIORITY_VALUES,
  ISSUE_STATUS_VALUES,
  type IssueEstimateValue,
  type IssuePriority,
  type IssueStatus,
} from "@/features/issues/types";
import { workspaceIssueDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";

type IssuesPageClientProps = {
  initialData: IssueListPageData;
};

type MetadataTone = "amber" | "blue" | "gray" | "green" | "purple" | "red";

const activeStatuses: IssueStatus[] = ["todo", "in_progress", "in_review"];
const sortCycle: IssueListQueryState["sort"][] = ["updated", "priority", "status", "created"];

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

const pillToneClasses: Record<MetadataTone, string> = {
  amber: "border-[#ecdcb0] bg-[#fdf8ef] text-[#8a6c19]",
  blue: "border-[#d0e2f7] bg-[#f4f8fd] text-[#4a75b0]",
  gray: "border-[#e0e0e0] bg-[#f5f5f5] text-[#6b6f76]",
  green: "border-[#cde8cf] bg-[#f2faf3] text-[#3d7f4e]",
  purple: "border-[#e0d6f7] bg-[#f8f5fd] text-[#6b4fb5]",
  red: "border-[#f0d2d5] bg-[#fdf5f5] text-[#a04855]",
};

const pillDotClasses: Record<MetadataTone, string> = {
  amber: "bg-[#f3c742]",
  blue: "bg-[#6ba0e7]",
  gray: "bg-[#b0b3b8]",
  green: "bg-[#6db57c]",
  purple: "bg-[#b489ff]",
  red: "bg-[#e28083]",
};

const statusTone: Record<IssueStatus, MetadataTone> = {
  backlog: "gray",
  canceled: "red",
  done: "green",
  in_progress: "blue",
  in_review: "purple",
  todo: "amber",
};

const priorityTone: Record<IssuePriority, MetadataTone> = {
  high: "amber",
  low: "blue",
  medium: "purple",
  none: "gray",
  urgent: "red",
};

function valuesMatch<T>(left: readonly T[], right: readonly T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildWorkspacePrefix(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, " ").trim();

  if (!normalized) {
    return "WL";
  }

  const parts = normalized.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  const letters = normalized.replace(/[^a-zA-Z]/g, "");

  if (letters.length <= 2) {
    return letters.toUpperCase();
  }

  const tail =
    letters
      .slice(3)
      .split("")
      .find((character) => !"aeiouyAEIOUY".includes(character)) ?? letters[1];

  return `${letters[0]}${tail}`.toUpperCase();
}

function buildIssueIdentifier(workspaceName: string, issueNumber: number) {
  return `${buildWorkspacePrefix(workspaceName)}-${issueNumber}`;
}

function cycleSortField(current: IssueListQueryState["sort"]) {
  const currentIndex = sortCycle.indexOf(current);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % sortCycle.length;

  return sortCycle[nextIndex];
}

function parseEstimateValue(value: string): IssueEstimateValue | undefined {
  if (value === "null") {
    return null;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) ? (parsed as IssueEstimateValue) : undefined;
}

function FilterChip({
  active,
  children,
  compact = false,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "linear-filter-chip",
        active && "linear-filter-chip-active",
        compact && "h-7 px-2.5 text-[12px]",
      )}
    >
      {children}
    </button>
  );
}

function IconButton({
  active = false,
  ariaLabel,
  children,
  onClick,
}: {
  active?: boolean;
  ariaLabel: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "linear-icon-button",
        active && "border-border-strong bg-surface-muted text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function MetadataPill({ label, tone }: { label: string; tone: MetadataTone }) {
  return (
    <span className={cn("linear-list-pill", pillToneClasses[tone])}>
      <span className={cn("h-2.5 w-2.5 rounded-full", pillDotClasses[tone])} />
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}

function AssigneePill({ label }: { label: string }) {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
    .slice(0, 2);

  return (
    <span className="linear-list-pill max-w-[10rem] border-[#e0e0e0] bg-[#f5f5f5] text-[#6b6f76]">
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#e0e2e6] text-[9px] font-semibold text-[#555a64]">
        {initials || "?"}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

function describeCurrentView(queryState: IssueListQueryState, showOnlyUnassigned: boolean) {
  if (showOnlyUnassigned) {
    return "Unassigned current cycle";
  }

  if (valuesMatch(queryState.statuses, ["backlog"])) {
    return "Backlog";
  }

  if (valuesMatch(queryState.statuses, activeStatuses)) {
    return "Active";
  }

  if (valuesMatch(queryState.statuses, ["done"])) {
    return "Done";
  }

  if (valuesMatch(queryState.statuses, ["canceled"])) {
    return "Canceled";
  }

  if (valuesMatch(queryState.estimates, [null])) {
    return "Unestimated current cycle";
  }

  return "All issues";
}

export function IssuesPageClient({ initialData }: IssuesPageClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const controlsRequested = searchParams.get("controls") === "1";
  const isCreateOpen = searchParams.get("create") === "1";
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [isRoutePending, startTransition] = useTransition();
  const [issues, setIssues] = useState(initialData.issues);
  const [searchDraft, setSearchDraft] = useState(initialData.queryState.query);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const [showOnlyUnassigned, setShowOnlyUnassigned] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState<IssueStatus | "">("");
  const [bulkPriority, setBulkPriority] = useState<IssuePriority | "">("");
  const [bulkEstimate, setBulkEstimate] = useState<string>("");
  const [preferencesJson, setPreferencesJson] = useState(
    initialData.currentMember?.preferences ?? null,
  );
  const [showControls, setShowControls] = useState(
    () =>
      controlsRequested ||
      initialData.queryState.query.length > 0 ||
      initialData.queryState.priorities.length > 0 ||
      initialData.queryState.estimates.some((value) => value !== null) ||
      initialData.queryState.sort !== "updated" ||
      initialData.queryState.direction !== "desc",
  );

  useEffect(() => {
    if (controlsRequested) {
      setShowControls(true);
    }
  }, [controlsRequested]);

  useEffect(() => {
    setIssues(initialData.issues);
  }, [initialData.issues]);

  useEffect(() => {
    setSearchDraft(initialData.queryState.query);
  }, [initialData.queryState.query]);

  useEffect(() => {
    setPreferencesJson(initialData.currentMember?.preferences ?? null);
  }, [initialData.currentMember?.preferences]);

  useEffect(() => {
    setSelectedIssueIds((currentIds) =>
      currentIds.filter((issueId) => initialData.issues.some((issue) => issue.id === issueId)),
    );
  }, [initialData.issues]);

  useEffect(() => {
    setSelectedIssueIds((currentIds) =>
      currentIds.filter((issueId) =>
        issues.some(
          (issue) => issue.id === issueId && (!showOnlyUnassigned || issue.assignee === null),
        ),
      ),
    );
  }, [issues, showOnlyUnassigned]);

  const queryState = initialData.queryState;
  const selectedIssueIdSet = new Set(selectedIssueIds);
  const visibleIssues = issues.filter((issue) => !showOnlyUnassigned || issue.assignee === null);
  const hasFilters =
    queryState.query.length > 0 ||
    queryState.statuses.length > 0 ||
    queryState.priorities.length > 0 ||
    queryState.estimates.length > 0 ||
    queryState.sort !== "updated" ||
    queryState.direction !== "desc" ||
    showOnlyUnassigned;
  const isActivePreset = valuesMatch(queryState.statuses, activeStatuses);
  const isBacklogPreset = valuesMatch(queryState.statuses, ["backlog"]);
  const isDonePreset = valuesMatch(queryState.statuses, ["done"]);
  const isCanceledPreset = valuesMatch(queryState.statuses, ["canceled"]);
  const isUnestimatedPreset = valuesMatch(queryState.estimates, [null]);
  const viewLabel = describeCurrentView(queryState, showOnlyUnassigned);

  function buildPageUrl(
    nextState: IssueListQueryState,
    viewState?: {
      create?: boolean;
      controls?: boolean;
    },
  ) {
    const params = serializeIssueListQueryState(nextState);

    if (viewState?.controls ?? showControls) {
      params.set("controls", "1");
    }

    if (viewState?.create ?? isCreateOpen) {
      params.set("create", "1");
    }

    return params.size > 0 ? `${pathname}?${params.toString()}` : pathname;
  }

  function navigateToQueryState(nextState: IssueListQueryState) {
    const nextUrl = buildPageUrl(nextState);

    setErrorMessage(null);
    setSuccessMessage(null);

    startTransition(() => {
      router.replace(nextUrl);
    });
  }

  function replaceViewState(viewState: { create?: boolean; controls?: boolean }) {
    startTransition(() => {
      router.replace(buildPageUrl(queryState, viewState));
    });
  }

  async function persistSortPreference(nextState: IssueListQueryState) {
    if (!initialData.currentMember) {
      return;
    }

    const nextPreferences = mergeIssueListPreferences(preferencesJson, {
      direction: nextState.direction,
      sort: nextState.sort,
    });

    setPreferencesJson(nextPreferences);

    const { error } = await supabase
      .from("workspace_members")
      .update({
        preferences: nextPreferences,
      })
      .eq("id", initialData.currentMember.id);

    if (error) {
      console.error("Failed to store issue list preferences", error);
    }
  }

  function updateQueryState(partial: Partial<IssueListQueryState>) {
    const nextState: IssueListQueryState = {
      ...queryState,
      ...partial,
    };

    navigateToQueryState(nextState);

    if (partial.sort !== undefined || partial.direction !== undefined) {
      void persistSortPreference(nextState);
    }
  }

  function toggleStatus(status: IssueStatus) {
    const statuses = queryState.statuses.includes(status)
      ? queryState.statuses.filter((value) => value !== status)
      : [...queryState.statuses, status];

    updateQueryState({
      statuses,
    });
  }

  function togglePriority(priority: IssuePriority) {
    const priorities = queryState.priorities.includes(priority)
      ? queryState.priorities.filter((value) => value !== priority)
      : [...queryState.priorities, priority];

    updateQueryState({
      priorities,
    });
  }

  function toggleEstimate(estimate: IssueEstimateValue) {
    const estimates = queryState.estimates.includes(estimate)
      ? queryState.estimates.filter((value) => value !== estimate)
      : [...queryState.estimates, estimate];

    updateQueryState({
      estimates,
    });
  }

  function handlePresetStatuses(statuses: IssueStatus[]) {
    setShowOnlyUnassigned(false);
    updateQueryState({
      statuses,
    });
  }

  function handleSelectIssue(issueId: string, checked: boolean) {
    setSelectedIssueIds((currentIds) =>
      checked ? [...currentIds, issueId] : currentIds.filter((currentId) => currentId !== issueId),
    );
  }

  function handleToggleAllVisible(checked: boolean) {
    setSelectedIssueIds(checked ? visibleIssues.map((issue) => issue.id) : []);
  }

  function handleControlsToggle() {
    const nextShowControls = !showControls;

    setShowControls(nextShowControls);
    replaceViewState({
      controls: nextShowControls,
    });
  }

  function openCreateDialog() {
    replaceViewState({
      create: true,
    });
  }

  function closeCreateDialog() {
    replaceViewState({
      create: false,
    });
  }

  async function handleBulkUpdate(
    patch: Parameters<typeof updateIssueRows>[2],
    successLabel: string,
  ) {
    if (selectedIssueIds.length === 0) {
      return;
    }

    setIsMutating(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      await updateIssueRows(supabase, selectedIssueIds, patch);
      setSelectedIssueIds([]);
      setBulkStatus("");
      setBulkPriority("");
      setBulkEstimate("");
      setSuccessMessage(successLabel);
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Bulk update failed.");
    } finally {
      setIsMutating(false);
    }
  }

  async function handleBulkDelete() {
    if (selectedIssueIds.length === 0) {
      return;
    }

    if (!window.confirm(`Delete ${selectedIssueIds.length} selected issues?`)) {
      return;
    }

    setIsMutating(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const { error } = await supabase.from("issues").delete().in("id", selectedIssueIds);

      if (error) {
        throw error;
      }

      setSelectedIssueIds([]);
      setSuccessMessage("Selected issues deleted.");
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Bulk delete failed.");
    } finally {
      setIsMutating(false);
    }
  }

  return (
    <>
      <CreateIssueDialog
        members={initialData.members}
        onClose={closeCreateDialog}
        onCreated={(issueNumber) => {
          router.push(workspaceIssueDetailPath(initialData.workspace.slug, issueNumber));
        }}
        open={isCreateOpen}
        workspaceId={initialData.workspace.id}
      />

      <div className="flex min-h-full flex-col bg-surface">
        <section className="border-b border-border px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <FilterChip
                active={!hasFilters}
                onClick={() => {
                  setShowOnlyUnassigned(false);
                  setSearchDraft("");
                  navigateToQueryState({
                    direction: "desc",
                    estimates: [],
                    priorities: [],
                    query: "",
                    sort: "updated",
                    statuses: [],
                  });
                }}
              >
                All issues
              </FilterChip>
              <FilterChip
                active={isActivePreset}
                onClick={() => handlePresetStatuses(activeStatuses)}
              >
                Active
              </FilterChip>
              <FilterChip
                active={isBacklogPreset}
                onClick={() => handlePresetStatuses(["backlog"])}
              >
                Backlog
              </FilterChip>
              <FilterChip
                active={isUnestimatedPreset}
                onClick={() => {
                  setShowOnlyUnassigned(false);
                  updateQueryState({
                    estimates: isUnestimatedPreset ? [] : [null],
                  });
                }}
              >
                Unestimated current cycle
              </FilterChip>
              <FilterChip
                active={showOnlyUnassigned}
                onClick={() => setShowOnlyUnassigned((current) => !current)}
              >
                Unassigned current cycle
              </FilterChip>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openCreateDialog}
                className="ui-button-primary h-8 gap-2 rounded-full px-3 py-0 text-[12px]"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Create
              </button>
              <IconButton
                active={showControls}
                ariaLabel="Toggle controls"
                onClick={handleControlsToggle}
              >
                <FilterIcon className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                ariaLabel="Cycle sort field"
                onClick={() =>
                  updateQueryState({
                    sort: cycleSortField(queryState.sort),
                  })
                }
              >
                <SlidersIcon className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                ariaLabel="Toggle sort direction"
                onClick={() =>
                  updateQueryState({
                    direction: queryState.direction === "desc" ? "asc" : "desc",
                  })
                }
              >
                <LayoutIcon className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </div>
        </section>

        {showControls ? (
          <section className="border-b border-border bg-[#f8f8f8] px-5 py-4">
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                updateQueryState({
                  query: searchDraft.trim(),
                });
              }}
            >
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="relative min-w-0 flex-1 xl:max-w-[28rem]">
                  <label className="sr-only" htmlFor="issue-search">
                    Search Issues
                  </label>
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                  <input
                    id="issue-search"
                    type="search"
                    name="query"
                    autoComplete="off"
                    value={searchDraft}
                    onChange={(event) => setSearchDraft(event.target.value)}
                    placeholder="Search Titles or Descriptions…"
                    className="ui-input h-9 rounded-full py-0 pl-9 pr-3 text-[13px] shadow-none"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    disabled={isRoutePending}
                    className="ui-button h-9 rounded-full px-4 py-0 text-[12px]"
                  >
                    {isRoutePending ? "Refreshing…" : "Search Issues"}
                  </button>
                  {queryState.query ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchDraft("");
                        updateQueryState({
                          query: "",
                        });
                      }}
                      className="ui-button h-9 rounded-full px-4 py-0 text-[12px]"
                    >
                      Clear
                    </button>
                  ) : null}

                  <select
                    aria-label="Sort Issues"
                    value={queryState.sort}
                    onChange={(event) =>
                      updateQueryState({
                        sort: event.target.value as IssueListQueryState["sort"],
                      })
                    }
                    className="ui-select h-9 min-w-[9rem] rounded-full py-0 text-[12px] shadow-none"
                  >
                    <option value="updated">Sort: Updated</option>
                    <option value="created">Sort: Created</option>
                    <option value="priority">Sort: Priority</option>
                    <option value="status">Sort: Status</option>
                  </select>

                  <select
                    aria-label="Change Sort Direction"
                    value={queryState.direction}
                    onChange={(event) =>
                      updateQueryState({
                        direction: event.target.value as IssueListQueryState["direction"],
                      })
                    }
                    className="ui-select h-9 min-w-[9rem] rounded-full py-0 text-[12px] shadow-none"
                  >
                    <option value="desc">Descending</option>
                    <option value="asc">Ascending</option>
                  </select>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-3">
                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                    Status
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ISSUE_STATUS_VALUES.map((status) => (
                      <FilterChip
                        key={status}
                        compact
                        active={queryState.statuses.includes(status)}
                        onClick={() => toggleStatus(status)}
                      >
                        {status.replaceAll("_", " ")}
                      </FilterChip>
                    ))}
                    <FilterChip
                      compact
                      active={isDonePreset}
                      onClick={() => handlePresetStatuses(["done"])}
                    >
                      Done Preset
                    </FilterChip>
                    <FilterChip
                      compact
                      active={isCanceledPreset}
                      onClick={() => handlePresetStatuses(["canceled"])}
                    >
                      Canceled Preset
                    </FilterChip>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                    Priority
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ISSUE_PRIORITY_VALUES.map((priority) => (
                      <FilterChip
                        key={priority}
                        compact
                        active={queryState.priorities.includes(priority)}
                        onClick={() => togglePriority(priority)}
                      >
                        {priority}
                      </FilterChip>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                    Estimate
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ISSUE_ESTIMATE_VALUES.map((estimate) => (
                      <FilterChip
                        key={estimate === null ? "null" : estimate}
                        compact
                        active={queryState.estimates.includes(estimate)}
                        onClick={() => toggleEstimate(estimate)}
                      >
                        {estimate === null ? "No estimate" : `${estimate} pt`}
                      </FilterChip>
                    ))}
                  </div>
                </div>
              </div>
            </form>
          </section>
        ) : null}

        {selectedIssueIds.length > 0 ? (
          <section className="border-b border-border bg-[#f7f7f7] px-5 py-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-[#6b6f76]">
                <span className="font-medium text-foreground">
                  {selectedIssueIds.length} selected
                </span>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={
                      visibleIssues.length > 0 && selectedIssueIds.length === visibleIssues.length
                    }
                    onChange={(event) => handleToggleAllVisible(event.target.checked)}
                    className="h-4 w-4 rounded border-border/80"
                  />
                  Select Visible
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Bulk Status"
                  value={bulkStatus}
                  onChange={(event) => setBulkStatus(event.target.value as IssueStatus | "")}
                  className="ui-select h-9 min-w-[8.5rem] rounded-full py-0 text-[12px] shadow-none"
                >
                  <option value="">Status</option>
                  {ISSUE_STATUS_VALUES.map((status) => (
                    <option key={status} value={status}>
                      {status.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Bulk Priority"
                  value={bulkPriority}
                  onChange={(event) => setBulkPriority(event.target.value as IssuePriority | "")}
                  className="ui-select h-9 min-w-[8.5rem] rounded-full py-0 text-[12px] shadow-none"
                >
                  <option value="">Priority</option>
                  {ISSUE_PRIORITY_VALUES.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Bulk Estimate"
                  value={bulkEstimate}
                  onChange={(event) => setBulkEstimate(event.target.value)}
                  className="ui-select h-9 min-w-[8.5rem] rounded-full py-0 text-[12px] shadow-none"
                >
                  <option value="">Estimate</option>
                  {ISSUE_ESTIMATE_VALUES.map((estimate) => (
                    <option
                      key={estimate === null ? "null" : estimate}
                      value={estimate === null ? "null" : String(estimate)}
                    >
                      {estimate === null
                        ? "No estimate"
                        : `${estimate} point${estimate === 1 ? "" : "s"}`}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={!bulkStatus || isMutating}
                  onClick={() =>
                    bulkStatus
                      ? void handleBulkUpdate(
                          { status: bulkStatus },
                          `Updated ${selectedIssueIds.length} issue${selectedIssueIds.length === 1 ? "" : "s"} status.`,
                        )
                      : undefined
                  }
                  className="ui-button h-9 rounded-full px-4 py-0 text-[12px]"
                >
                  Apply Status
                </button>

                <button
                  type="button"
                  disabled={!bulkPriority || isMutating}
                  onClick={() =>
                    bulkPriority
                      ? void handleBulkUpdate(
                          { priority: bulkPriority },
                          `Updated ${selectedIssueIds.length} issue${selectedIssueIds.length === 1 ? "" : "s"} priority.`,
                        )
                      : undefined
                  }
                  className="ui-button h-9 rounded-full px-4 py-0 text-[12px]"
                >
                  Apply Priority
                </button>

                <button
                  type="button"
                  disabled={bulkEstimate === "" || isMutating}
                  onClick={() => {
                    const nextEstimate = parseEstimateValue(bulkEstimate);

                    if (bulkEstimate !== "" && nextEstimate !== undefined) {
                      void handleBulkUpdate(
                        { estimate_points: nextEstimate },
                        `Updated ${selectedIssueIds.length} issue${selectedIssueIds.length === 1 ? "" : "s"} estimate.`,
                      );
                    }
                  }}
                  className="ui-button h-9 rounded-full px-4 py-0 text-[12px]"
                >
                  Apply Estimate
                </button>

                <button
                  type="button"
                  disabled={isMutating}
                  onClick={() => setSelectedIssueIds([])}
                  className="ui-button h-9 rounded-full px-4 py-0 text-[12px]"
                >
                  Clear
                </button>

                <button
                  type="button"
                  disabled={isMutating}
                  onClick={() => void handleBulkDelete()}
                  className="ui-button-danger h-9 rounded-full px-4 py-0 text-[12px]"
                >
                  Delete
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {errorMessage ? (
          <div
            aria-live="polite"
            role="status"
            className="border-b border-[#f0d2d5] bg-[#fdf5f5] px-5 py-3 text-[13px] text-danger"
          >
            {errorMessage}
          </div>
        ) : null}

        {successMessage ? (
          <div
            aria-live="polite"
            role="status"
            className="border-b border-[#cde8cf] bg-[#f2faf3] px-5 py-3 text-[13px] text-success"
          >
            {successMessage}
          </div>
        ) : null}

        <section className="flex flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border bg-[#f5f5f5] px-5 py-2.5">
            <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[#4a4d54]">
              <ChevronDownIcon className="h-3.5 w-3.5 text-[#b0b3b8]" />
              <StateCircleIcon className="h-3.5 w-3.5 text-[#b8bbc2]" />
              <span>{viewLabel}</span>
              <span className="flex items-center gap-1 text-[#7a7d84]">
                <PriorityTriangleIcon className="h-3.5 w-3.5" />
                {visibleIssues.length}
              </span>
            </div>

            <span className="text-[12px] text-muted tabular-nums">
              {visibleIssues.length} Visible
            </span>
          </div>

          {visibleIssues.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
              <h2 className="text-[17px] font-semibold text-balance text-foreground">
                No Issues Match This View
              </h2>
              <p className="mt-2 max-w-md text-[13px] leading-6 text-muted">
                Adjust the current filters or create an issue to seed the workspace queue.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[#efefef]">
              {visibleIssues.map((issue) => {
                const assigneeLabel = getIssueMemberDisplayName(issue.assignee);

                return (
                  <div
                    key={issue.id}
                    className={cn(
                      "group grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-2.5 transition-colors duration-150",
                      selectedIssueIdSet.has(issue.id) && "bg-[#f0f0f0]",
                      !selectedIssueIdSet.has(issue.id) && "hover:bg-[#f8f8f8]",
                    )}
                  >
                    <label className="flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={selectedIssueIdSet.has(issue.id)}
                        onChange={(event) => handleSelectIssue(issue.id, event.target.checked)}
                        className={cn(
                          "h-4 w-4 rounded border border-[#d0d0d0] transition-opacity duration-150",
                          selectedIssueIdSet.has(issue.id)
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        )}
                      />
                    </label>

                    <Link
                      href={workspaceIssueDetailPath(initialData.workspace.slug, issue.number)}
                      className="flex min-w-0 items-center gap-2.5"
                    >
                      <IssueBarsIcon className="h-3.5 w-3.5 text-[#8c8f94]" />
                      <span className="min-w-[3.9rem] text-[13px] font-medium text-[#8c8f94]">
                        {buildIssueIdentifier(initialData.workspace.name, issue.number)}
                      </span>
                      <StateCircleIcon className="h-3.5 w-3.5 text-[#b8bbc2]" />
                      <span className="truncate text-[14px] font-medium text-[#1d1f22]">
                        {issue.title}
                      </span>
                    </Link>

                    <div className="flex flex-wrap items-center justify-end gap-2 pl-4">
                      {issue.priority !== "none" ? (
                        <MetadataPill
                          label={formatIssuePriority(issue.priority)}
                          tone={priorityTone[issue.priority]}
                        />
                      ) : null}
                      {issue.status !== "backlog" ? (
                        <MetadataPill
                          label={formatIssueStatus(issue.status)}
                          tone={statusTone[issue.status]}
                        />
                      ) : null}
                      {issue.estimatePoints !== null ? (
                        <MetadataPill
                          label={`${issue.estimatePoints} point${issue.estimatePoints === 1 ? "" : "s"}`}
                          tone="gray"
                        />
                      ) : null}
                      {issue.assignee ? <AssigneePill label={assigneeLabel} /> : null}
                      <span className="flex items-center gap-1.5 text-[13px] tabular-nums text-[#8c8f94]">
                        <UsersIcon className="h-3.5 w-3.5" />
                        {shortDateFormatter.format(new Date(issue.updatedAt))}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
