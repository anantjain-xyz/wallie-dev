"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

import { updateIssueRows } from "@/features/issues/client";
import { CreateIssueDialog } from "@/features/issues/list/create-issue-dialog";
import {
  type IssueListQueryState,
  mergeIssueListPreferences,
  serializeIssueListQueryState,
} from "@/features/issues/list/query-state";
import type { IssueListPageData } from "@/features/issues/list/data";
import { IssueEstimateBadge, IssueMemberBadge, IssuePriorityBadge, IssueStatusBadge } from "@/features/issues/ui";
import {
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

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[12px] font-medium transition",
        active
          ? "border-accent/20 bg-accent-soft text-accent"
          : "border-border bg-surface text-muted hover:bg-surface-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function parseEstimateValue(value: string): IssueEstimateValue | undefined {
  if (value === "null") {
    return null;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) ? (parsed as IssueEstimateValue) : undefined;
}

export function IssuesPageClient({ initialData }: IssuesPageClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [isRoutePending, startTransition] = useTransition();
  const [issues, setIssues] = useState(initialData.issues);
  const [searchDraft, setSearchDraft] = useState(initialData.queryState.query);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState<IssueStatus | "">("");
  const [bulkPriority, setBulkPriority] = useState<IssuePriority | "">("");
  const [bulkEstimate, setBulkEstimate] = useState<string>("");
  const [preferencesJson, setPreferencesJson] = useState(
    initialData.currentMember?.preferences ?? null,
  );

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
      currentIds.filter((issueId) =>
        initialData.issues.some((issue) => issue.id === issueId),
      ),
    );
  }, [initialData.issues]);

  const selectedIssueIdSet = new Set(selectedIssueIds);
  const queryState = initialData.queryState;
  const hasFilters =
    queryState.query.length > 0 ||
    queryState.statuses.length > 0 ||
    queryState.priorities.length > 0 ||
    queryState.estimates.length > 0 ||
    queryState.sort !== "updated" ||
    queryState.direction !== "desc";

  function navigateToQueryState(nextState: IssueListQueryState) {
    const params = serializeIssueListQueryState(nextState);
    const nextUrl = params.size > 0 ? `${pathname}?${params.toString()}` : pathname;

    setErrorMessage(null);
    setSuccessMessage(null);

    startTransition(() => {
      router.replace(nextUrl);
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

    if (
      partial.sort !== undefined ||
      partial.direction !== undefined
    ) {
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
      checked
        ? [...currentIds, issueId]
        : currentIds.filter((currentId) => currentId !== issueId),
    );
  }

  function handleToggleAllVisible(checked: boolean) {
    setSelectedIssueIds(checked ? issues.map((issue) => issue.id) : []);
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
      setErrorMessage(
        error instanceof Error ? error.message : "Bulk update failed.",
      );
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
      const { error } = await supabase
        .from("issues")
        .delete()
        .in("id", selectedIssueIds);

      if (error) {
        throw error;
      }

      setSelectedIssueIds([]);
      setSuccessMessage("Selected issues deleted.");
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Bulk delete failed.",
      );
    } finally {
      setIsMutating(false);
    }
  }

  return (
    <>
      <CreateIssueDialog
        members={initialData.members}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(issueNumber) => {
          setIsCreateOpen(false);
          router.push(
            workspaceIssueDetailPath(initialData.workspace.slug, issueNumber),
          );
        }}
        open={isCreateOpen}
        workspaceId={initialData.workspace.id}
      />

      <div className="grid gap-4">
        <section className="ui-panel p-5">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <p className="text-[11px] font-medium text-muted">
                Issues
              </p>
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  All issues
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
                  Search, filter, sort, and bulk edit the workspace queue with
                  server-rendered state and narrow client hydration.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="ui-pill px-3 py-1.5 text-sm text-muted">
                Showing{" "}
                <span className="font-semibold text-foreground">{issues.length}</span>{" "}
                of{" "}
                <span className="font-semibold text-foreground">
                  {initialData.totalIssueCount}
                </span>{" "}
                issues
              </div>
              <button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="ui-button-primary"
              >
                Create issue
              </button>
            </div>
          </div>
        </section>

        <section className="ui-panel p-5">
          <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                updateQueryState({
                  query: searchDraft.trim(),
                });
              }}
            >
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="Search title and description"
                  className="ui-input min-w-0 flex-1"
                />
                <button
                  type="submit"
                  disabled={isRoutePending}
                  className="ui-button"
                >
                  {isRoutePending ? "Refreshing..." : "Search"}
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
                    className="ui-button"
                  >
                    Clear
                  </button>
                ) : null}
              </div>

              <div className="space-y-3">
                <p className="ui-label">
                  Quick filters
                </p>
                <div className="flex flex-wrap gap-2">
                  <FilterButton
                    active={
                      queryState.statuses.join(",") ===
                      ["todo", "in_progress", "in_review"].join(",")
                    }
                    onClick={() =>
                      handlePresetStatuses(["todo", "in_progress", "in_review"])
                    }
                  >
                    Active
                  </FilterButton>
                  <FilterButton
                    active={queryState.statuses.join(",") === "backlog"}
                    onClick={() => handlePresetStatuses(["backlog"])}
                  >
                    Backlog
                  </FilterButton>
                  <FilterButton
                    active={queryState.statuses.join(",") === "done"}
                    onClick={() => handlePresetStatuses(["done"])}
                  >
                    Done
                  </FilterButton>
                  <FilterButton
                    active={queryState.statuses.join(",") === "canceled"}
                    onClick={() => handlePresetStatuses(["canceled"])}
                  >
                    Canceled
                  </FilterButton>
                  {hasFilters ? (
                    <FilterButton
                      active={false}
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
                      Reset
                    </FilterButton>
                  ) : null}
                </div>
              </div>
            </form>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Sort</span>
                <select
                  value={queryState.sort}
                  onChange={(event) =>
                    updateQueryState({
                      sort: event.target.value as IssueListQueryState["sort"],
                    })
                  }
                  className="ui-select"
                >
                  <option value="updated">Updated</option>
                  <option value="created">Created</option>
                  <option value="priority">Priority</option>
                  <option value="status">Status</option>
                </select>
              </label>

              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Direction</span>
                <select
                  value={queryState.direction}
                  onChange={(event) =>
                    updateQueryState({
                      direction: event.target.value as IssueListQueryState["direction"],
                    })
                  }
                  className="ui-select"
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </label>
            </div>
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-3">
            <div className="space-y-3">
              <p className="ui-label">
                Status
              </p>
              <div className="flex flex-wrap gap-2">
                {ISSUE_STATUS_VALUES.map((status) => (
                  <FilterButton
                    key={status}
                    active={queryState.statuses.includes(status)}
                    onClick={() => toggleStatus(status)}
                  >
                    {status.replaceAll("_", " ")}
                  </FilterButton>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <p className="ui-label">
                Priority
              </p>
              <div className="flex flex-wrap gap-2">
                {ISSUE_PRIORITY_VALUES.map((priority) => (
                  <FilterButton
                    key={priority}
                    active={queryState.priorities.includes(priority)}
                    onClick={() => togglePriority(priority)}
                  >
                    {priority}
                  </FilterButton>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <p className="ui-label">
                Estimate
              </p>
              <div className="flex flex-wrap gap-2">
                {ISSUE_ESTIMATE_VALUES.map((estimate) => (
                  <FilterButton
                    key={estimate === null ? "null" : estimate}
                    active={queryState.estimates.includes(estimate)}
                    onClick={() => toggleEstimate(estimate)}
                  >
                    {estimate === null ? "No estimate" : `${estimate} pt`}
                  </FilterButton>
                ))}
              </div>
            </div>
          </div>
        </section>

        {errorMessage ? (
          <div className="rounded-[12px] border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger">
            {errorMessage}
          </div>
        ) : null}

        {successMessage ? (
          <div className="rounded-[12px] border border-success/20 bg-success-soft px-4 py-3 text-sm text-success">
            {successMessage}
          </div>
        ) : null}

        {selectedIssueIds.length > 0 ? (
          <section className="ui-panel p-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <p className="ui-label">
                  Bulk actions
                </p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {selectedIssueIds.length} issue
                  {selectedIssueIds.length === 1 ? "" : "s"} selected across the
                  current filtered result set.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3 xl:w-[36rem]">
                <label className="space-y-2 text-sm font-semibold text-foreground">
                  <span>Status</span>
                  <select
                    value={bulkStatus}
                    onChange={(event) =>
                      setBulkStatus(event.target.value as IssueStatus | "")
                    }
                    className="ui-select"
                  >
                    <option value="">Choose</option>
                    {ISSUE_STATUS_VALUES.map((status) => (
                      <option key={status} value={status}>
                        {status.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2 text-sm font-semibold text-foreground">
                  <span>Priority</span>
                  <select
                    value={bulkPriority}
                    onChange={(event) =>
                      setBulkPriority(event.target.value as IssuePriority | "")
                    }
                    className="ui-select"
                  >
                    <option value="">Choose</option>
                    {ISSUE_PRIORITY_VALUES.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2 text-sm font-semibold text-foreground">
                  <span>Estimate</span>
                  <select
                    value={bulkEstimate}
                    onChange={(event) => setBulkEstimate(event.target.value)}
                    className="ui-select"
                  >
                    <option value="">Choose</option>
                    {ISSUE_ESTIMATE_VALUES.map((estimate) => (
                      <option
                        key={estimate === null ? "null" : estimate}
                        value={estimate === null ? "null" : String(estimate)}
                      >
                        {estimate === null ? "No estimate" : `${estimate} point${estimate === 1 ? "" : "s"}`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
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
                className="ui-button"
              >
                Apply status
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
                className="ui-button"
              >
                Apply priority
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
                className="ui-button"
              >
                Apply estimate
              </button>
              <button
                type="button"
                disabled={isMutating}
                onClick={() => setSelectedIssueIds([])}
                className="ui-button"
              >
                Clear selection
              </button>
              <button
                type="button"
                disabled={isMutating}
                onClick={() => void handleBulkDelete()}
                className="ui-button-danger"
              >
                Delete selected
              </button>
            </div>
          </section>
        ) : null}

        <section className="ui-panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <p className="ui-label">
                Issue list
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                Workspace scoped rows for{" "}
                <span className="font-mono text-foreground/90">
                  /w/{initialData.workspace.slug}
                </span>
              </p>
            </div>

            <label className="flex items-center gap-3 text-sm text-foreground">
              <input
                type="checkbox"
                checked={
                  issues.length > 0 && selectedIssueIds.length === issues.length
                }
                onChange={(event) => handleToggleAllVisible(event.target.checked)}
                className="h-4 w-4 rounded border-border/80"
              />
              Select visible
            </label>
          </div>

          {issues.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <h3 className="text-xl font-semibold text-foreground">
                No issues match this view
              </h3>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted">
                Adjust the current search, filters, or sort state, or create a new
                issue to seed the workspace.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {issues.map((issue) => (
                <div
                  key={issue.id}
                  className="grid gap-3 px-4 py-3 transition hover:bg-surface-strong/60 lg:grid-cols-[auto_1fr_auto] lg:items-center"
                >
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedIssueIdSet.has(issue.id)}
                      onChange={(event) =>
                        handleSelectIssue(issue.id, event.target.checked)
                      }
                      className="mt-1 h-4 w-4 rounded border-border/80"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                        <span className="ui-pill font-mono">
                          #{issue.number}
                        </span>
                        <IssueStatusBadge status={issue.status} />
                        <IssuePriorityBadge priority={issue.priority} />
                        <IssueEstimateBadge estimatePoints={issue.estimatePoints} />
                      </div>
                      <Link
                        href={workspaceIssueDetailPath(
                          initialData.workspace.slug,
                          issue.number,
                        )}
                        className="mt-2 block text-[15px] font-semibold leading-6 text-foreground transition hover:text-accent"
                      >
                        {issue.title}
                      </Link>
                      <p className="mt-1 line-clamp-2 max-w-3xl text-sm leading-6 text-muted">
                        {issue.descriptionMd || "No description yet."}
                      </p>
                    </div>
                  </label>

                  <div className="grid gap-3 text-sm text-muted sm:grid-cols-2 lg:grid-cols-1">
                    <div>
                      <p className="ui-label">
                        Assignee
                      </p>
                      <div className="mt-2">
                        <IssueMemberBadge member={issue.assignee} />
                      </div>
                    </div>
                    <div>
                      <p className="ui-label">
                        Updated
                      </p>
                      <p className="mt-2 text-foreground">
                        {dateTimeFormatter.format(new Date(issue.updatedAt))}
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-start lg:justify-end">
                    <Link
                      href={workspaceIssueDetailPath(
                        initialData.workspace.slug,
                        issue.number,
                      )}
                      className="ui-button"
                    >
                      Open issue
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
