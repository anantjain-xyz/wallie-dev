"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Spinner } from "@/components/shared/spinner";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import {
  archiveSessionFromClient,
  unarchiveSessionFromClient,
  updateSessionTitleFromClient,
} from "@/features/sessions/client";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import {
  SessionDetailLink,
  SessionDetailLinkPrefetchBoundary,
} from "@/features/sessions/components/session-detail-link";
import { SessionPhaseStatusLabel } from "@/features/sessions/components/session-phase-status-label";
import { SessionsZeroState } from "@/features/sessions/components/sessions-zero-state";
import type { SessionListPageData } from "@/features/sessions/list/data";
import {
  type SessionFilterKey,
  type SessionListItem,
  type SessionListQueryState,
} from "@/features/sessions/types";
import { ArchiveIcon, CheckIcon, PencilIcon, SearchIcon, XIcon } from "@/components/shared/icons";
import { workspaceSessionDetailPath, workspaceSessionsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type SessionsPageClientProps = {
  initialData: SessionListPageData;
};

function buildHref(
  base: string,
  state: Pick<SessionListQueryState, "cursor" | "stageSlug" | "query" | "scope">,
): string {
  const params = new URLSearchParams();
  if (state.stageSlug) params.set("stage", state.stageSlug);
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.scope !== "all") params.set("scope", state.scope);
  if (state.cursor) params.set("cursor", state.cursor);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const SCOPE_CHIPS: { key: SessionFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "has-pr", label: "Has PR" },
  { key: "archived", label: "Archived" },
];

export function SessionsPageClient({ initialData }: SessionsPageClientProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const workspaceSlug = initialData.workspace.slug;
  const basePath = workspaceSessionsPath(workspaceSlug);

  function updateQueryState(next: Partial<SessionListQueryState>) {
    const merged: SessionListQueryState = {
      cursor: next.cursor !== undefined ? next.cursor : null,
      query: next.query !== undefined ? next.query : initialData.queryState.query,
      scope: next.scope !== undefined ? next.scope : initialData.queryState.scope,
      stageSlug: next.stageSlug !== undefined ? next.stageSlug : initialData.queryState.stageSlug,
    };
    startTransition(() => {
      router.replace(buildHref(basePath, merged));
    });
  }

  function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = searchInputRef.current?.value ?? "";
    updateQueryState({ query: value });
  }

  const sessions = initialData.sessions;
  // Build the stage filter chips from whatever stages appear in the loaded
  // sessions. This keeps the chip set in sync with workspaces that have
  // edited their pipeline; we don't need to know the workspace's pipeline
  // shape at this layer. Chips are ordered by the stage's pipeline `position`
  // so they line up with the board columns, with name as a stable tiebreak
  // for the (cross-pipeline) case where two stages share a position.
  const stageGroups = useMemo(() => {
    const order = [...initialData.stageFacets].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    const counts = new Map(order.map((stage) => [stage.slug, stage.count]));

    return { counts, order };
  }, [initialData.stageFacets]);

  return (
    <PageContainer>
      <PageHeader title="Sessions" />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <form
          onSubmit={handleSearchSubmit}
          className="relative w-full flex-none sm:max-w-md sm:flex-1 sm:min-w-[220px]"
        >
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            key={initialData.queryState.query}
            ref={searchInputRef}
            type="search"
            defaultValue={initialData.queryState.query}
            placeholder="Search prompts, titles, Linear IDs"
            className="ui-input pl-8"
            aria-label="Search sessions"
          />
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          {SCOPE_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={cn(
                "ui-filter-chip",
                initialData.queryState.scope === chip.key && "ui-filter-chip-active",
              )}
              onClick={() => updateQueryState({ scope: chip.key })}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={cn(
              "ui-filter-chip",
              initialData.queryState.stageSlug === null && "ui-filter-chip-active",
            )}
            onClick={() => updateQueryState({ stageSlug: null })}
          >
            All stages
          </button>
          {stageGroups.order.map((stage) => (
            <button
              key={stage.slug}
              type="button"
              className={cn(
                "ui-filter-chip",
                initialData.queryState.stageSlug === stage.slug && "ui-filter-chip-active",
              )}
              onClick={() => updateQueryState({ stageSlug: stage.slug })}
            >
              {stage.name}
              <span className="ml-1 text-[10px] text-muted">
                {stageGroups.counts.get(stage.slug) ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {sessions.length === 0 ? (
        !initialData.hasAnySession ? (
          <SessionsZeroState
            onboarding={initialData.onboarding}
            workspaceSlug={workspaceSlug}
            newSessionHref={workspaceSessionsPath(workspaceSlug, { create: 1 })}
          />
        ) : (
          <div className="flex flex-col items-center rounded-[10px] border border-dashed border-border bg-surface-strong px-6 py-16 text-center">
            <p className="text-[14px] font-semibold text-foreground">
              No sessions match these filters
            </p>
            <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted">
              Adjust the stage, scope, or search to see more sessions.
            </p>
          </div>
        )
      ) : (
        <SessionDetailLinkPrefetchBoundary>
          <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface">
            {sessions.map((session) => (
              <SessionRow key={session.id} session={session} workspaceSlug={workspaceSlug} />
            ))}
          </ul>
        </SessionDetailLinkPrefetchBoundary>
      )}

      {initialData.hasMore && initialData.nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Link
            className="ui-button"
            href={buildHref(basePath, {
              ...initialData.queryState,
              cursor: initialData.nextCursor,
            })}
          >
            Load older sessions
          </Link>
        </div>
      ) : null}
    </PageContainer>
  );
}

function SessionRow({
  session,
  workspaceSlug,
}: {
  session: SessionListItem;
  workspaceSlug: string;
}) {
  const detailHref = workspaceSessionDetailPath(workspaceSlug, session.number);
  const [displayTitle, setDisplayTitle] = useState(session.title);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const [archivedAt, setArchivedAt] = useState(session.archivedAt);
  const [phaseStatus, setPhaseStatus] = useState(session.phaseStatus);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [archivePending, setArchivePending] = useState<"archive" | "unarchive" | null>(null);
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const previousSessionTitleRef = useRef(session.title);

  const isArchived = Boolean(archivedAt);
  const archiveActionLabel = archivePending
    ? archivePending === "archive"
      ? "Archive"
      : "Unarchive"
    : isArchived
      ? "Unarchive"
      : "Archive";

  async function toggleArchive() {
    if (archivePending) return;
    const action = isArchived ? "unarchive" : "archive";
    const previousArchivedAt = archivedAt;
    const previousPhaseStatus = phaseStatus;
    setArchivePending(action);
    setArchiveError(null);
    setArchivedAt(isArchived ? null : new Date().toISOString());
    if (!isArchived && phaseStatus === "agent_generating") setPhaseStatus("rejected");

    try {
      const result = isArchived
        ? await unarchiveSessionFromClient({ sessionId: session.id })
        : await archiveSessionFromClient({ sessionId: session.id });
      setArchivedAt(result.archivedAt);
      setPhaseStatus(result.phaseStatus);
      setArchiveConfirming(false);
    } catch (errorValue) {
      setArchivedAt(previousArchivedAt);
      setPhaseStatus(previousPhaseStatus);
      setArchiveError(
        errorValue instanceof Error
          ? errorValue.message
          : `Failed to ${archiveActionLabel.toLowerCase()} session.`,
      );
    } finally {
      setArchivePending(null);
    }
  }

  useEffect(() => {
    if (previousSessionTitleRef.current === session.title) return;
    previousSessionTitleRef.current = session.title;
    setDisplayTitle(session.title);
    if (!isEditing) {
      setDraftTitle(session.title);
    }
  }, [isEditing, session.title]);

  useEffect(() => {
    if (!isEditing) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [isEditing]);

  function startEditing() {
    setDraftTitle(displayTitle);
    setError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    setDraftTitle(displayTitle);
    setError(null);
    setIsEditing(false);
  }

  function getErrorMessage(errorValue: unknown) {
    return errorValue instanceof Error ? errorValue.message : "Failed to update session title.";
  }

  async function saveTitle() {
    if (isSaving) {
      return;
    }

    const normalizedTitle = draftTitle.trim();

    if (!normalizedTitle) {
      setError("Title is required.");
      return;
    }

    if (normalizedTitle === displayTitle) {
      setDraftTitle(displayTitle);
      setError(null);
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    setError(null);
    const previousTitle = displayTitle;
    setDisplayTitle(normalizedTitle);
    setIsEditing(false);

    try {
      const result = await updateSessionTitleFromClient({
        sessionId: session.id,
        title: normalizedTitle,
      });
      setDisplayTitle(result.title);
      setDraftTitle(result.title);
    } catch (errorValue) {
      setDisplayTitle(previousTitle);
      setDraftTitle(normalizedTitle);
      setIsEditing(true);
      setError(getErrorMessage(errorValue));
    } finally {
      setIsSaving(false);
    }
  }

  function handleEditSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveTitle();
  }

  return (
    <li className="group relative flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-surface-strong sm:px-5 md:flex-row md:items-center">
      <SessionDetailLink
        href={detailHref}
        className="absolute inset-0 z-10 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="sr-only">
          Open session #{session.number}: {displayTitle}
        </span>
      </SessionDetailLink>

      <div className="pointer-events-none relative z-20 flex min-w-0 flex-1 flex-col gap-1">
        {isEditing ? (
          <form className="pointer-events-auto relative z-30" onSubmit={handleEditSubmit}>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <span className="font-mono text-[11px] text-muted">#{session.number}</span>
              <input
                ref={editInputRef}
                aria-label={`Session #${session.number} title`}
                className="ui-input h-8 min-w-0 flex-1 px-2 py-1 text-[14px] font-medium"
                disabled={isSaving}
                value={draftTitle}
                onChange={(event) => {
                  setDraftTitle(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEditing();
                  }
                }}
              />
              <div className="flex items-center gap-1">
                <button
                  type="submit"
                  className="ui-icon-button h-8 w-8 text-accent"
                  aria-label={`Save title for session #${session.number}`}
                  title="Save title"
                  disabled={isSaving}
                >
                  {isSaving ? (
                    <Spinner className="h-3.5 w-3.5" label="Saving title" />
                  ) : (
                    <CheckIcon className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  className="ui-icon-button h-8 w-8"
                  aria-label={`Cancel title edit for session #${session.number}`}
                  title="Cancel title edit"
                  disabled={isSaving}
                  onClick={cancelEditing}
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="flex min-w-0 items-start gap-2 md:items-center">
            <span className="font-mono text-[11px] text-muted">#{session.number}</span>
            <span
              className="line-clamp-2 min-w-0 text-[14px] font-medium text-foreground md:block md:truncate"
              title={displayTitle}
            >
              {displayTitle}
            </span>
            <button
              type="button"
              className="ui-icon-button pointer-events-auto relative z-30 h-7 w-7 shrink-0"
              aria-label={
                isSaving
                  ? `Saving title for session #${session.number}`
                  : `Edit title for session #${session.number}`
              }
              title={isSaving ? "Saving title" : "Edit title"}
              disabled={isSaving}
              onClick={startEditing}
            >
              {isSaving ? (
                <Spinner className="h-3.5 w-3.5" label="Saving title" />
              ) : (
                <PencilIcon className="h-3.5 w-3.5" />
              )}
            </button>
            {archiveConfirming ? (
              <div className="pointer-events-auto relative z-30 flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="ui-icon-button h-7 w-7 text-danger"
                  aria-label={`Confirm ${archiveActionLabel.toLowerCase()} for session #${session.number}`}
                  title={`Confirm ${archiveActionLabel.toLowerCase()}`}
                  disabled={archivePending !== null}
                  onClick={() => void toggleArchive()}
                >
                  {archivePending ? (
                    <Spinner className="h-3.5 w-3.5" label={`${archiveActionLabel} session`} />
                  ) : (
                    <CheckIcon className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  className="ui-icon-button h-7 w-7"
                  aria-label={`Cancel ${archiveActionLabel.toLowerCase()} for session #${session.number}`}
                  title="Cancel"
                  disabled={archivePending !== null}
                  onClick={() => {
                    setArchiveConfirming(false);
                    setArchiveError(null);
                  }}
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="ui-icon-button pointer-events-auto relative z-30 h-7 w-7 shrink-0"
                aria-label={`${archiveActionLabel} session #${session.number}`}
                title={archiveActionLabel}
                onClick={() => {
                  setArchiveConfirming(true);
                  setArchiveError(null);
                }}
              >
                <ArchiveIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span>{session.currentStageName}</span>
          <span>·</span>
          <SessionPhaseStatusLabel status={phaseStatus} />
          <span>·</span>
          <span>updated {relativeTime(session.updatedAt)}</span>
          {archivedAt ? (
            <>
              <span>·</span>
              <span className="text-muted">archived</span>
            </>
          ) : null}
        </div>
        {error ? (
          <p className="pointer-events-auto text-[11px] leading-4 text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {archiveError ? (
          <p className="pointer-events-auto text-[11px] leading-4 text-danger" role="alert">
            {archiveError}
          </p>
        ) : null}
      </div>

      <div className="pointer-events-none relative z-20 shrink-0">
        <SessionConnections
          className="pointer-events-auto"
          compact
          linearIssueId={session.linearIssueId}
          linearIssueUrl={session.linearIssueUrl}
          pullRequestCount={session.pullRequestCount}
          pullRequests={session.pullRequests}
        />
      </div>
    </li>
  );
}
