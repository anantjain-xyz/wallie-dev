"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Spinner } from "@/components/shared/spinner";
import { ActionMenu } from "@/components/ui/action-menu";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Status, sessionPhaseStatusValue } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
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
  resolveOptimisticTitle,
  type TitleOverride,
} from "@/features/sessions/list/sessions-list-mutations";
import type { SessionFilterKey, SessionListItem } from "@/features/sessions/types";
import { CheckIcon } from "@/components/shared/icons/check-icon";
import { PencilIcon } from "@/components/shared/icons/pencil-icon";
import { XIcon } from "@/components/shared/icons/x-icon";
import { cn } from "@/lib/utils";

type SessionRowIslandProps = {
  connections: ReactNode;
  detailHref: string;
  metaTrailing: ReactNode;
  scope: SessionFilterKey;
  session: SessionListItem;
  stageName: string;
};

export function SessionRowIsland({
  connections,
  detailHref,
  metaTrailing,
  scope,
  session,
  stageName,
}: SessionRowIslandProps) {
  const { pushToast } = useToast();
  const [titleOverride, setTitleOverride] = useState<TitleOverride | null>(null);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const [optimisticArchive, setOptimisticArchive] = useState<{
    archivedAt: string | null;
    phaseStatus: SessionListItem["phaseStatus"];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [archivePending, setArchivePending] = useState<"archive" | "unarchive" | null>(null);
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const actionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const latestSessionRef = useRef(session);
  latestSessionRef.current = session;

  const displayTitle = resolveOptimisticTitle(session, titleOverride);
  const archivedAt = optimisticArchive ? optimisticArchive.archivedAt : session.archivedAt;
  const phaseStatus = optimisticArchive ? optimisticArchive.phaseStatus : session.phaseStatus;
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
    setArchivePending(action);
    setArchiveError(null);
    setOptimisticArchive({
      archivedAt: isArchived ? null : new Date().toISOString(),
      phaseStatus: !isArchived && phaseStatus === "agent_generating" ? "rejected" : phaseStatus,
    });

    try {
      const result = isArchived
        ? await unarchiveSessionFromClient({ sessionId: session.id })
        : await archiveSessionFromClient({ sessionId: session.id });
      setArchiveConfirming(false);
      setOptimisticArchive({
        archivedAt: result.archivedAt,
        phaseStatus: result.phaseStatus,
      });
      pushToast({
        title: result.archivedAt ? "Session archived" : "Session unarchived",
        description: `#${session.number} · ${displayTitle}`,
        tone: "success",
      });
    } catch (errorValue) {
      const message =
        errorValue instanceof Error
          ? errorValue.message
          : `Failed to ${archiveActionLabel.toLowerCase()} session.`;
      setArchiveError(message);
      setOptimisticArchive(null);
      pushToast({
        title: `Could not ${archiveActionLabel.toLowerCase()} session`,
        description: message,
        tone: "danger",
        priority: "assertive",
      });
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
    (scope === "active" && Boolean(archivedAt)) || (scope === "archived" && !archivedAt);

  if (hiddenFromCurrentScope) {
    return null;
  }

  return (
    <li
      className={cn(
        "session-list-row group flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-control-hover sm:px-5 md:flex-row md:items-center",
        (isEditing || archiveConfirming || archivePending !== null || error || archiveError) &&
          "content-visibility-interacting",
      )}
    >
      <div className="relative flex min-w-0 flex-1 flex-col gap-1">
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
          <div className="flex min-w-0 items-start gap-2 md:items-center">
            <span className="font-mono type-annotation text-muted">#{session.number}</span>
            <SessionDetailLink
              href={detailHref}
              trackSessionsToDetail
              aria-label={`Open session #${session.number}: ${displayTitle}`}
              className="line-clamp-2 min-w-0 text-[14px] font-medium text-foreground hover:text-accent md:block md:truncate"
            >
              {displayTitle}
            </SessionDetailLink>
            <ActionMenu
              className="h-7 w-7 shrink-0"
              disabled={isSaving || archivePending !== null}
              label={`Actions for session #${session.number}`}
              ref={actionMenuTriggerRef}
            >
              <DropdownMenuItem onSelect={startEditing}>
                <PencilIcon className="h-3.5 w-3.5" />
                Edit title
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-danger"
                onSelect={() => {
                  setArchiveConfirming(true);
                  setArchiveError(null);
                }}
              >
                {archiveActionLabel} session
              </DropdownMenuItem>
            </ActionMenu>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 type-annotation text-muted">
          <span>{stageName}</span>
          <span>·</span>
          <Status compact value={sessionPhaseStatusValue(phaseStatus)} />
          {metaTrailing}
          {archivedAt ? (
            <>
              <span>·</span>
              <span className="text-muted">archived</span>
            </>
          ) : null}
        </div>
        {error ? (
          <p className="text-xs leading-4 text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {archiveError ? (
          <p className="text-xs leading-4 text-danger" role="alert">
            {archiveError}
          </p>
        ) : null}
      </div>

      <div className="shrink-0">{connections}</div>

      <DestructiveConfirmationDialog
        actionLabel={`${archiveActionLabel} session`}
        description={`${archiveActionLabel} session #${session.number}, “${displayTitle}”? ${
          archiveActionLabel === "Unarchive"
            ? "It will return to active session views."
            : "It will leave active session views but remain available in the archived filter."
        }`}
        errorMessage={archiveError}
        onConfirm={() => void toggleArchive()}
        onOpenChange={(open) => {
          setArchiveConfirming(open);
          if (!open) setArchiveError(null);
        }}
        open={archiveConfirming}
        pending={archivePending !== null}
        pendingLabel={`${archiveActionLabel === "Archive" ? "Archiving" : "Unarchiving"}…`}
        restoreFocusRef={actionMenuTriggerRef}
        title={`${archiveActionLabel} session #${session.number}?`}
      />
    </li>
  );
}

export function SessionsLedger({ children }: { children: ReactNode }) {
  return (
    <SessionDetailLinkPrefetchBoundary>
      <ul className="ui-sheet divide-y divide-border overflow-hidden">{children}</ul>
    </SessionDetailLinkPrefetchBoundary>
  );
}
