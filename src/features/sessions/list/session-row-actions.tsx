"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { CheckIcon } from "@/components/shared/icons/check-icon";
import { PencilIcon } from "@/components/shared/icons/pencil-icon";
import { XIcon } from "@/components/shared/icons/x-icon";
import { Spinner } from "@/components/shared/spinner";
import { ActionMenu } from "@/components/ui/action-menu";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Status, sessionPhaseStatusValue, resolveStatusDefinition } from "@/components/ui/status";
import { useOptionalToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import {
  archiveSessionFromClient,
  unarchiveSessionFromClient,
  updateSessionTitleFromClient,
} from "@/features/sessions/client";
import {
  SessionDetailLink,
  SessionDetailLinkPrefetchBoundary,
} from "@/features/sessions/components/session-detail-link";
import {
  resolveOptimisticArchive,
  resolveOptimisticTitle,
  shouldApplyArchiveResult,
  type ArchiveOverride,
  type TitleOverride,
} from "@/features/sessions/list/sessions-list-mutations";
import { useSessionsLedgerVisibility } from "@/features/sessions/list/sessions-ledger-visibility";
import type { SessionFilterKey, SessionListItem } from "@/features/sessions/types";
import { cn } from "@/lib/utils";

/** Mutation + display fields only — keep the hydrated payload off full list RPC rows. */
export type SessionRowIslandSession = Pick<
  SessionListItem,
  "archivedAt" | "id" | "number" | "phaseStatus" | "title" | "updatedAt"
>;

type SessionRowIslandProps = {
  connections: ReactNode;
  detailHref: string;
  repositoryLabel: string | null;
  scope: SessionFilterKey;
  session: SessionRowIslandSession;
  stageName: string;
  updated: ReactNode;
};

function archiveOverrideFromSession(
  session: SessionRowIslandSession,
  next: Pick<SessionRowIslandSession, "archivedAt" | "phaseStatus">,
): ArchiveOverride {
  return {
    authoritativeArchivedAt: session.archivedAt,
    authoritativeUpdatedAt: session.updatedAt,
    archivedAt: next.archivedAt,
    phaseStatus: next.phaseStatus,
  };
}

function LedgerStatus({ phaseStatus }: { phaseStatus: SessionRowIslandSession["phaseStatus"] }) {
  const value = sessionPhaseStatusValue(phaseStatus);
  // Awaiting review keeps the strongest Status affordance; other statuses stay
  // text-only so the ledger does not border every Status cell.
  if (phaseStatus === "awaiting_review") {
    return <Status compact value={value} />;
  }

  const definition = resolveStatusDefinition(value);
  return (
    <span className="type-annotation text-muted" data-status={value} data-tone={definition.tone}>
      {definition.label}
    </span>
  );
}

export function SessionRowIsland({
  connections,
  detailHref,
  repositoryLabel,
  scope,
  session,
  stageName,
  updated,
}: SessionRowIslandProps) {
  const router = useRouter();
  const { dismissToast, pushToast } = useOptionalToast();
  const visibility = useSessionsLedgerVisibility();
  const archiveInFlightRef = useRef(false);
  const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [titleOverride, setTitleOverride] = useState<TitleOverride | null>(null);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const [archiveOverride, setArchiveOverride] = useState<ArchiveOverride | null>(null);
  const [locallyHidden, setLocallyHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [archivePending, setArchivePending] = useState<"archive" | "unarchive" | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const latestSessionRef = useRef(session);
  latestSessionRef.current = session;

  const displayTitle = resolveOptimisticTitle(session, titleOverride);
  const { archivedAt, phaseStatus } = resolveOptimisticArchive(session, archiveOverride);
  const isArchived = Boolean(archivedAt);

  function setRowHidden(hidden: boolean) {
    setLocallyHidden(hidden);
    if (!visibility) return;
    if (hidden) visibility.hideSession(session.id);
    else visibility.showSession(session.id);
  }

  function requestArchive() {
    if (archiveInFlightRef.current || locallyHidden) return;

    archiveInFlightRef.current = true;
    setArchivePending("archive");
    setArchiveDialogOpen(false);
    setRowHidden(true);
    setArchiveError(null);
    const archivePromise = archiveSessionFromClient({ sessionId: session.id });

    const pendingToastId = pushToast({
      duration: Number.POSITIVE_INFINITY,
      priority: "polite",
      title: `Archiving session #${session.number}…`,
    });

    const archivedAtAtMutationStart = latestSessionRef.current.archivedAt;

    void archivePromise
      .then((result) => {
        archiveInFlightRef.current = false;
        setArchivePending(null);
        dismissToast(pendingToastId);
        const latestSession = latestSessionRef.current;
        if (!shouldApplyArchiveResult(result, latestSession, archivedAtAtMutationStart)) {
          setArchiveOverride(null);
          setRowHidden(false);
          return;
        }

        // Archive can return archivedAt: null when a concurrent unarchive won, or
        // when cancel parked the session active with a newer phaseStatus/updatedAt.
        if (!result.archivedAt) {
          setArchiveOverride(
            archiveOverrideFromSession(latestSession, {
              archivedAt: null,
              phaseStatus: result.phaseStatus,
            }),
          );
          setRowHidden(false);
          pushToast({
            priority: "polite",
            title: `Session #${session.number} remains active.`,
          });
          router.refresh();
          return;
        }

        const archivedAtResult = result.archivedAt;
        setArchiveOverride(
          archiveOverrideFromSession(latestSession, {
            archivedAt: archivedAtResult,
            phaseStatus: result.phaseStatus,
          }),
        );
        pushToast({
          action: {
            altText: `Undo archive for session #${session.number}`,
            label: "Undo",
            onClick: () => {
              void (async () => {
                try {
                  const archivedAtBeforeUndo = latestSessionRef.current.archivedAt;
                  const undoResult = await unarchiveSessionFromClient({
                    expectedArchivedAt: archivedAtResult,
                    sessionId: session.id,
                  });
                  if (undoResult.archivedAt !== null) return;
                  const latestAfterUndo = latestSessionRef.current;
                  if (
                    !shouldApplyArchiveResult(undoResult, latestAfterUndo, archivedAtBeforeUndo)
                  ) {
                    setArchiveOverride(null);
                    setRowHidden(false);
                    archiveInFlightRef.current = false;
                    return;
                  }
                  setArchiveOverride(
                    archiveOverrideFromSession(latestAfterUndo, {
                      archivedAt: null,
                      phaseStatus: undoResult.phaseStatus,
                    }),
                  );
                  setRowHidden(false);
                  archiveInFlightRef.current = false;
                  pushToast({
                    priority: "polite",
                    title: `Archive undone for session #${session.number}.`,
                    tone: "success",
                  });
                  // Refresh so server-owned metaTrailing / ordering catch up after undo.
                  router.refresh();
                } catch (errorValue) {
                  pushToast({
                    description:
                      errorValue instanceof Error
                        ? errorValue.message
                        : "The session remains archived.",
                    priority: "assertive",
                    title: `Could not undo archive for session #${session.number}.`,
                    tone: "danger",
                  });
                }
              })();
            },
          },
          duration: 7000,
          priority: "polite",
          title: `Session #${session.number} archived.`,
          tone: "success",
        });
      })
      .catch((errorValue) => {
        archiveInFlightRef.current = false;
        setArchivePending(null);
        setRowHidden(false);
        dismissToast(pendingToastId);
        pushToast({
          description:
            errorValue instanceof Error ? errorValue.message : "The session was restored.",
          priority: "assertive",
          title: `Could not archive session #${session.number}.`,
          tone: "danger",
        });
      });
  }

  async function unarchive() {
    if (archivePending) return;
    setArchivePending("unarchive");
    setArchiveError(null);
    const authoritativeAtStart = latestSessionRef.current;
    setArchiveOverride(
      archiveOverrideFromSession(authoritativeAtStart, {
        archivedAt: null,
        phaseStatus,
      }),
    );
    if (scope === "archived") {
      setRowHidden(true);
    }

    try {
      const result = await unarchiveSessionFromClient({ sessionId: session.id });
      const latestSession = latestSessionRef.current;
      if (!shouldApplyArchiveResult(result, latestSession, authoritativeAtStart.archivedAt)) {
        setArchiveOverride(null);
        setRowHidden(false);
        return;
      }
      setArchiveOverride(
        archiveOverrideFromSession(latestSession, {
          archivedAt: result.archivedAt,
          phaseStatus: result.phaseStatus,
        }),
      );
      if (scope === "archived" && result.archivedAt === null) {
        // stay hidden from archived scope
      } else {
        setRowHidden(false);
      }
      pushToast({
        priority: "polite",
        title: `Session #${session.number} unarchived.`,
        tone: "success",
      });
      // Refresh so server-owned ordering catch up when the row stays visible.
      // Override clears once refreshed props diverge from the keyed authoritative snapshot.
      router.refresh();
    } catch (errorValue) {
      const message =
        errorValue instanceof Error ? errorValue.message : "Failed to unarchive session.";
      setArchiveOverride(null);
      setRowHidden(false);
      // Toast survives even if this island was unmounted while the last archived row was hidden.
      pushToast({
        description: message,
        priority: "assertive",
        title: `Could not unarchive session #${session.number}.`,
        tone: "danger",
      });
      setArchiveError(message);
    } finally {
      setArchivePending(null);
    }
  }

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
    const previousOverride = titleOverride;
    const titleAtMutationStart = latestSessionRef.current.title;
    const authoritativeAtStart = latestSessionRef.current;
    setTitleOverride({
      authoritativeTitle: authoritativeAtStart.title,
      authoritativeUpdatedAt: authoritativeAtStart.updatedAt,
      title: normalizedTitle,
    });
    setIsEditing(false);

    try {
      const result = await updateSessionTitleFromClient({
        sessionId: session.id,
        title: normalizedTitle,
      });
      const latestSession = latestSessionRef.current;
      const shouldApply =
        result.updatedAt >= latestSession.updatedAt || latestSession.title === titleAtMutationStart;
      if (shouldApply) {
        setTitleOverride({
          authoritativeTitle: latestSession.title,
          authoritativeUpdatedAt: latestSession.updatedAt,
          title: result.title,
        });
        pushToast({ priority: "polite", title: "Session title updated.", tone: "success" });
        // Refresh so the server ledger reorders by updated_at and metadata catches up.
        router.refresh();
      } else {
        setTitleOverride(null);
      }
    } catch (errorValue) {
      setTitleOverride(previousOverride);
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

  const hiddenFromCurrentScope =
    (scope !== "archived" && locallyHidden) ||
    (scope === "active" && Boolean(archivedAt)) ||
    (scope === "archived" && !archivedAt);

  if (hiddenFromCurrentScope) {
    return null;
  }

  return (
    <div
      role="row"
      className={cn(
        "session-list-row sessions-ledger-row group",
        (isEditing || archivePending !== null || error || archiveError) &&
          "content-visibility-interacting",
      )}
    >
      <div className="sessions-ledger-cell sessions-ledger-cell-session" role="cell">
        {isEditing ? (
          <form onSubmit={handleEditSubmit}>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <span className="font-mono type-annotation text-muted">#{session.number}</span>
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
                <Tooltip content="Save title">
                  <button
                    type="submit"
                    className="ui-icon-button h-8 w-8 text-accent"
                    aria-label={`Save title for session #${session.number}`}
                    disabled={isSaving}
                  >
                    {isSaving ? (
                      <Spinner className="h-3.5 w-3.5" label="Saving title" />
                    ) : (
                      <CheckIcon className="h-3.5 w-3.5" />
                    )}
                  </button>
                </Tooltip>
                <Tooltip content="Cancel title edit">
                  <button
                    type="button"
                    className="ui-icon-button h-8 w-8"
                    aria-label={`Cancel title edit for session #${session.number}`}
                    disabled={isSaving}
                    onClick={cancelEditing}
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>
          </form>
        ) : (
          <div className="min-w-0 space-y-1.5">
            <div className="flex min-w-0 items-start gap-2">
              <span className="font-mono type-annotation text-muted">#{session.number}</span>
              <Tooltip content={displayTitle}>
                <SessionDetailLink
                  href={detailHref}
                  trackSessionsToDetail
                  aria-label={`Open session #${session.number}: ${displayTitle}`}
                  className="line-clamp-2 min-w-0 text-[14px] font-medium text-foreground hover:text-accent md:truncate"
                >
                  {displayTitle}
                </SessionDetailLink>
              </Tooltip>
            </div>
            {connections ? <div className="sessions-ledger-connections">{connections}</div> : null}
            {archivedAt ? <span className="type-annotation text-muted">archived</span> : null}
          </div>
        )}
        {error ? (
          <p className="mt-1 text-xs leading-4 text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {archiveError ? (
          <p className="mt-1 text-xs leading-4 text-danger" role="alert">
            {archiveError}
          </p>
        ) : null}
      </div>

      <div className="sessions-ledger-cell sessions-ledger-cell-stage" role="cell">
        <span className="sessions-ledger-cell-label">Stage</span>
        <span className="text-[13px] text-foreground">{stageName}</span>
      </div>

      <div className="sessions-ledger-cell sessions-ledger-cell-status" role="cell">
        <span className="sessions-ledger-cell-label">Status</span>
        <LedgerStatus phaseStatus={phaseStatus} />
      </div>

      <div className="sessions-ledger-cell sessions-ledger-cell-repository" role="cell">
        <span className="sessions-ledger-cell-label">Repository</span>
        <span className="truncate text-[13px] text-muted" title={repositoryLabel ?? undefined}>
          {repositoryLabel ?? "—"}
        </span>
      </div>

      <div className="sessions-ledger-cell sessions-ledger-cell-updated" role="cell">
        <span className="sessions-ledger-cell-label">Updated</span>
        <span className="type-annotation text-muted">{updated}</span>
      </div>

      <div className="sessions-ledger-cell sessions-ledger-cell-actions" role="cell">
        {!isEditing ? (
          <>
            <ActionMenu
              className="h-8 w-8 shrink-0"
              disabled={isSaving || archivePending !== null}
              label={`Actions for session #${session.number}`}
              ref={actionsTriggerRef}
            >
              <DropdownMenuItem onSelect={startEditing}>
                <PencilIcon className="h-3.5 w-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-danger"
                onSelect={() => {
                  setArchiveError(null);
                  if (isArchived) void unarchive();
                  else setArchiveDialogOpen(true);
                }}
              >
                {isArchived ? "Unarchive" : "Archive"} session
              </DropdownMenuItem>
            </ActionMenu>
            <DestructiveConfirmationDialog
              actionLabel="Archive session"
              description={`Archive session #${session.number}? You can undo this for a few seconds afterward.`}
              onConfirm={requestArchive}
              onOpenChange={setArchiveDialogOpen}
              open={archiveDialogOpen}
              pending={archivePending === "archive"}
              pendingLabel="Archiving…"
              restoreFocusRef={actionsTriggerRef}
              title={`Archive session #${session.number}?`}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

export function SessionsLedger({ children }: { children: ReactNode }) {
  return (
    <SessionDetailLinkPrefetchBoundary>
      <div className="ui-sheet sessions-ledger overflow-hidden" role="table" aria-label="Sessions">
        <div role="row" className="sessions-ledger-header">
          <div role="columnheader">Session</div>
          <div role="columnheader">Stage</div>
          <div role="columnheader">Status</div>
          <div role="columnheader">Repository</div>
          <div role="columnheader">Updated</div>
          <div role="columnheader" className="sr-only">
            Actions
          </div>
        </div>
        <div role="rowgroup" className="divide-y divide-border">
          {children}
        </div>
      </div>
    </SessionDetailLinkPrefetchBoundary>
  );
}
