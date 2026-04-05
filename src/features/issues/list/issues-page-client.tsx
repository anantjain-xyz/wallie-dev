"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  ChevronDownIcon,
  FilterIcon,
  PlusIcon,
  PriorityBarIcon,
  PriorityUrgentIcon,
  SearchIcon,
  SlidersIcon,
  StatusBacklogIcon,
  StatusCanceledIcon,
  StatusDoneIcon,
  StatusInProgressIcon,
  StatusInReviewIcon,
  StatusTodoIcon,
} from "@/components/shared/icons";
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

const activeStatuses: IssueStatus[] = ["todo", "in_progress", "in_review"];
const sortCycle: IssueListQueryState["sort"][] = ["updated", "priority", "status", "created"];

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

const labelColors: Record<string, { bg: string; text: string; border: string }> = {
  // Issue labels
  Feature: { bg: "#dbeafe", text: "#3161a3", border: "#bfdbfe" },
  Improvement: { bg: "#e0e7ff", text: "#4338ca", border: "#c7d2fe" },
  Bug: { bg: "#fee2e2", text: "#b91c1c", border: "#fecaca" },
  Infra: { bg: "#f3e8ff", text: "#7c3aed", border: "#e9d5ff" },
  Security: { bg: "#fef3c7", text: "#92400e", border: "#fde68a" },
  Moderation: { bg: "#fce7f3", text: "#be185d", border: "#fbcfe8" },
  Product: { bg: "#d1fae5", text: "#065f46", border: "#a7f3d0" },
  // Status values
  todo: { bg: "#fef3c7", text: "#92400e", border: "#fde68a" },
  "in progress": { bg: "#fef3c7", text: "#b45309", border: "#fde68a" },
  "in review": { bg: "#e0e7ff", text: "#4338ca", border: "#c7d2fe" },
  done: { bg: "#d1fae5", text: "#065f46", border: "#a7f3d0" },
  canceled: { bg: "#f3f4f6", text: "#6b7280", border: "#e5e7eb" },
  // Priority values
  urgent: { bg: "#fee2e2", text: "#b91c1c", border: "#fecaca" },
  high: { bg: "#ffedd5", text: "#c2410c", border: "#fed7aa" },
  medium: { bg: "#fef3c7", text: "#a16207", border: "#fde68a" },
  low: { bg: "#dbeafe", text: "#1e60a8", border: "#bfdbfe" },
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

function TabItem({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative px-3 py-2 text-[13px] font-medium transition-colors duration-100",
        active ? "text-foreground" : "text-[#6b6f76] hover:text-foreground",
      )}
    >
      {children}
      {active && (
        <span className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full bg-[#5e6ad2]" />
      )}
    </button>
  );
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
        "ui-filter-chip",
        active && "ui-filter-chip-active",
        compact && "h-7 px-2.5 text-[12px]",
      )}
    >
      {children}
    </button>
  );
}

function ToolbarButton({
  ariaLabel,
  children,
  onClick,
}: {
  ariaLabel: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[#9ca0ab] transition-colors duration-100 hover:bg-[#ebebeb] hover:text-[#6b6f76]"
    >
      {children}
    </button>
  );
}

function PriorityIcon({ priority }: { priority: IssuePriority }) {
  if (priority === "urgent") {
    return <PriorityUrgentIcon className="h-4 w-4" />;
  }
  return <PriorityBarIcon className="h-4 w-4" priority={priority} />;
}

function StatusIcon({ status }: { status: IssueStatus }) {
  const icons: Record<IssueStatus, React.ComponentType<{ className?: string }>> = {
    backlog: StatusBacklogIcon,
    todo: StatusTodoIcon,
    in_progress: StatusInProgressIcon,
    in_review: StatusInReviewIcon,
    done: StatusDoneIcon,
    canceled: StatusCanceledIcon,
  };
  const Icon = icons[status];
  return <Icon className="h-3.5 w-3.5" />;
}

function LabelPill({ label }: { label: string }) {
  const colors = labelColors[label] ?? { bg: "#f0f0f0", text: "#6b6f76", border: "#e0e0e0" };
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full border px-[7px] py-[1px] text-[12px] font-medium capitalize leading-[18px]"
      style={{ backgroundColor: colors.bg, color: colors.text, borderColor: colors.border }}
    >
      {label}
    </span>
  );
}

function AssigneeAvatar({
  member,
}: {
  member: { fullName: string | null; username: string | null; avatarUrl: string | null };
}) {
  const name = member.fullName ?? member.username ?? "?";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("")
    .slice(0, 2);

  if (member.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={member.avatarUrl}
        alt={name}
        className="h-5 w-5 shrink-0 rounded-full object-cover"
      />
    );
  }

  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#e0e2e6] text-[9px] font-semibold text-[#555a64]"
      title={name}
    >
      {initials || "?"}
    </span>
  );
}

function describeCurrentView(queryState: IssueListQueryState) {
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
      currentIds.filter((issueId) => issues.some((issue) => issue.id === issueId)),
    );
  }, [issues]);

  const queryState = initialData.queryState;
  const selectedIssueIdSet = new Set(selectedIssueIds);
  const visibleIssues = issues;
  const hasFilters =
    queryState.query.length > 0 ||
    queryState.statuses.length > 0 ||
    queryState.priorities.length > 0 ||
    queryState.estimates.length > 0 ||
    queryState.sort !== "updated" ||
    queryState.direction !== "desc";
  const isActivePreset = valuesMatch(queryState.statuses, activeStatuses);
  const isBacklogPreset = valuesMatch(queryState.statuses, ["backlog"]);
  const isDonePreset = valuesMatch(queryState.statuses, ["done"]);
  const isCanceledPreset = valuesMatch(queryState.statuses, ["canceled"]);
  const viewLabel = describeCurrentView(queryState);

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
        {/* ── Header ── */}
        <header className="border-b border-border">
          {/* Top row: workspace heading */}
          <div className="flex items-center gap-2 px-6 pb-0 pt-5">
            <span className="flex h-5 w-5 items-center justify-center rounded-[4px] bg-[#5e6ad2] text-[10px] font-bold text-white">
              {initialData.workspace.name.charAt(0).toUpperCase()}
            </span>
            <h1 className="text-[15px] font-semibold text-foreground">
              {initialData.workspace.name}
            </h1>
          </div>

          {/* Tab bar + toolbar */}
          <div className="flex items-center justify-between px-6 pt-1">
            <nav className="flex items-center gap-0.5">
              <TabItem
                active={!hasFilters}
                onClick={() => {
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
              </TabItem>
              <TabItem active={isActivePreset} onClick={() => handlePresetStatuses(activeStatuses)}>
                Active
              </TabItem>
              <TabItem active={isBacklogPreset} onClick={() => handlePresetStatuses(["backlog"])}>
                Backlog
              </TabItem>
            </nav>

            <div className="flex items-center gap-1">
              <ToolbarButton ariaLabel="Add filter" onClick={handleControlsToggle}>
                <FilterIcon className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton
                ariaLabel="Display options"
                onClick={() =>
                  updateQueryState({
                    sort: cycleSortField(queryState.sort),
                  })
                }
              >
                <SlidersIcon className="h-3.5 w-3.5" />
              </ToolbarButton>
            </div>
          </div>
        </header>

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

        {/* ── Issue list ── */}
        <section className="flex flex-1 flex-col">
          {/* Group header */}
          <div className="flex h-[34px] items-center gap-2 border-b border-[#ebebeb] bg-[#f8f8f7] px-4">
            <button type="button" className="flex items-center text-[#9ca0ab]">
              <ChevronDownIcon className="h-3 w-3" />
            </button>
            <StatusIcon
              status={
                isBacklogPreset
                  ? "backlog"
                  : isActivePreset
                    ? "in_progress"
                    : isDonePreset
                      ? "done"
                      : isCanceledPreset
                        ? "canceled"
                        : "backlog"
              }
            />
            <span className="text-[13px] font-medium text-[#3c3f44]">{viewLabel}</span>
            <span className="ml-0.5 text-[12px] tabular-nums text-[#9ca0ab]">
              {visibleIssues.length}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={openCreateDialog}
              className="flex h-5 w-5 items-center justify-center rounded text-[#9ca0ab] transition-colors hover:bg-[#ebebeb] hover:text-[#6b6f76]"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </button>
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
            <div>
              {visibleIssues.map((issue) => (
                <div
                  key={issue.id}
                  className={cn(
                    "group flex h-[44px] items-center border-b border-[#ebebeb] transition-colors duration-100",
                    selectedIssueIdSet.has(issue.id) ? "bg-[#eff0ff]" : "hover:bg-[#f8f8f7]",
                  )}
                >
                  {/* Checkbox */}
                  <label className="flex w-[40px] shrink-0 items-center justify-center">
                    <input
                      type="checkbox"
                      checked={selectedIssueIdSet.has(issue.id)}
                      onChange={(event) => handleSelectIssue(issue.id, event.target.checked)}
                      className={cn(
                        "h-[14px] w-[14px] cursor-pointer rounded-[3px] border border-[#d0d2d6] transition-opacity duration-100",
                        selectedIssueIdSet.has(issue.id)
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                      )}
                    />
                  </label>

                  {/* Priority icon */}
                  <div className="flex w-[24px] shrink-0 items-center justify-center">
                    <PriorityIcon priority={issue.priority} />
                  </div>

                  {/* Issue ID */}
                  <span className="w-[56px] shrink-0 text-[13px] font-medium text-[#9ca0ab]">
                    {buildIssueIdentifier(initialData.workspace.name, issue.number)}
                  </span>

                  {/* Title — clicking navigates to detail */}
                  <Link
                    href={workspaceIssueDetailPath(initialData.workspace.slug, issue.number)}
                    className="mr-3 min-w-0 flex-1 truncate text-[14px] font-medium text-[#1b1b18] hover:text-[#5e6ad2]"
                  >
                    {issue.title}
                  </Link>

                  {/* Inline metadata — labels, status, estimate */}
                  <div className="flex shrink-0 items-center gap-1.5 pr-3">
                    {issue.status !== "backlog" && (
                      <LabelPill label={formatIssueStatus(issue.status)} />
                    )}
                    {issue.priority !== "none" && (
                      <LabelPill label={formatIssuePriority(issue.priority)} />
                    )}
                    {issue.estimatePoints !== null && (
                      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-[#e0e0e0] bg-[#f5f5f5] px-[7px] py-[1px] text-[12px] font-medium leading-[18px] text-[#6b6f76]">
                        {issue.estimatePoints} pt{issue.estimatePoints !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>

                  {/* Assignee avatar */}
                  <div className="flex w-[32px] shrink-0 items-center justify-center">
                    {issue.assignee ? (
                      <AssigneeAvatar member={issue.assignee} />
                    ) : (
                      <span className="h-5 w-5 rounded-full border border-dashed border-[#d0d2d6]" />
                    )}
                  </div>

                  {/* Created date */}
                  <span className="w-[100px] shrink-0 pr-4 text-right text-[12px] tabular-nums text-[#9ca0ab]">
                    {shortDateFormatter.format(new Date(issue.createdAt))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
