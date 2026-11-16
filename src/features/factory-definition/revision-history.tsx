"use client";

import Link from "next/link";
import { useId, useRef, useState, type ReactNode } from "react";

import { formatUtcTimestamp } from "@/components/shared/time-format";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { Status } from "@/components/ui/status";
import type {
  FactoryEditorActivation,
  FactoryEditorDocument,
} from "@/lib/factory-definitions/editor-contracts";
import { cn } from "@/lib/utils";

type RevisionHistoryProps = {
  activations: readonly FactoryEditorActivation[];
  activeActivationNumber: number;
  activeRevisionId: string | null;
  selectedRevisionId: string | null;
  selectedDocument: FactoryEditorDocument | null;
  nextBeforeActivationNumber: number | null;
  busy: boolean;
  canManage: boolean;
  activationEligible: boolean;
  candidateTests?: ReactNode;
  onSelect: (revisionId: string) => void;
  onLoadMore: () => void;
  onRollback: (revisionId: string, expectedActivationNumber: number) => Promise<void> | void;
  revisionHref: (revisionId: string) => string;
  sourceDraftHref: (draftId: string) => string;
};

type RollbackConfirmation = {
  revisionId: string;
  revisionDigest: string;
  activationNumber: number;
};

const sourceLinkClass =
  "inline-flex min-h-11 items-center text-xs font-medium text-accent underline underline-offset-2";

export function FactoryRevisionHistory({
  activations,
  activeActivationNumber,
  activeRevisionId,
  selectedRevisionId,
  selectedDocument,
  nextBeforeActivationNumber,
  busy,
  canManage,
  activationEligible,
  candidateTests,
  onSelect,
  onLoadMore,
  onRollback,
  revisionHref,
  sourceDraftHref,
}: RevisionHistoryProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [confirmation, setConfirmation] = useState<RollbackConfirmation | null>(null);
  const [rollbackPending, setRollbackPending] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const selectedActivationId = activations.find(
    ({ revisionId }) => revisionId === selectedRevisionId,
  )?.id;
  const selectedIsRevision = selectedDocument?.kind === "revision";
  const selectedIsActive = selectedIsRevision && selectedDocument.id === activeRevisionId;
  const allowRollback =
    canManage && selectedIsRevision && !selectedIsActive && activeActivationNumber > 0;
  const controlsDisabled = busy || rollbackPending;
  const canConfirm =
    allowRollback &&
    activationEligible &&
    confirmation?.revisionId === selectedDocument.id &&
    confirmation.revisionDigest === selectedDocument.digest &&
    confirmation.activationNumber === activeActivationNumber;

  async function confirmRollback() {
    if (!confirmation || !canConfirm || controlsDisabled) return;

    setRollbackError(null);
    setRollbackPending(true);
    try {
      await onRollback(confirmation.revisionId, confirmation.activationNumber);
      setConfirmation(null);
    } catch (cause) {
      setRollbackError(
        cause instanceof Error ? cause.message : "Could not activate this revision.",
      );
    } finally {
      setRollbackPending(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h2 className="type-section-title" id={headingId} ref={headingRef} tabIndex={-1}>
        Revision history
      </h2>
      {activations.length ? (
        <ol className="divide-y divide-border rounded-[6px] border border-border bg-surface">
          {activations.map((activation) => {
            const isCurrent = activation.activationNumber === activeActivationNumber;
            const isSelected = activation.id === selectedActivationId;
            const timestamp = formatUtcTimestamp(activation.createdAt);
            return (
              <li key={activation.id}>
                <button
                  aria-label={`Activation #${activation.activationNumber}, ${timestamp}${isCurrent ? ", current" : ""}`}
                  aria-pressed={isSelected}
                  className={cn(
                    "flex min-h-11 w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-control-hover disabled:opacity-60",
                    isSelected && "bg-control-muted",
                  )}
                  disabled={controlsDisabled}
                  onClick={() => onSelect(activation.revisionId)}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-foreground">
                      Activation #{activation.activationNumber}
                    </span>
                    <time className="block text-xs text-muted" dateTime={activation.createdAt}>
                      {timestamp}
                    </time>
                  </span>
                  {isCurrent ? <Status compact label="Current" value="approved" /> : null}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="type-secondary text-muted">
          {busy ? "Loading activation history…" : "Published revisions will appear here."}
        </p>
      )}
      {nextBeforeActivationNumber !== null && (
        <button
          className="ui-button min-h-11"
          disabled={controlsDisabled}
          onClick={onLoadMore}
          type="button"
        >
          Load older activations
        </button>
      )}
      {selectedDocument && (
        <div className="space-y-3 rounded-[6px] border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13px] font-medium text-foreground">
              {selectedIsRevision ? "Selected revision" : "Selected source draft"}
            </h3>
            {selectedIsActive && <Status compact label="Current" value="approved" />}
          </div>
          <dl className="space-y-2 text-xs">
            <div>
              <dt className="text-muted">{selectedIsRevision ? "Revision ID" : "Draft ID"}</dt>
              <dd className="font-mono text-foreground [overflow-wrap:anywhere]">
                {selectedDocument.id}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Digest</dt>
              <dd className="font-mono text-foreground [overflow-wrap:anywhere]">
                {selectedDocument.digest}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Created</dt>
              <dd className="text-foreground">
                <time dateTime={selectedDocument.createdAt}>
                  {formatUtcTimestamp(selectedDocument.createdAt)}
                </time>
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link
              className={sourceLinkClass}
              href={
                selectedIsRevision
                  ? revisionHref(selectedDocument.id)
                  : sourceDraftHref(selectedDocument.id)
              }
              prefetch={false}
              rel="noreferrer"
              target="_blank"
            >
              {selectedIsRevision ? "Revision permalink" : "Draft permalink"}
              <span className="sr-only"> (opens in a new tab)</span>
            </Link>
            {selectedDocument.sourceDraftId && (
              <Link
                className={sourceLinkClass}
                href={sourceDraftHref(selectedDocument.sourceDraftId)}
                prefetch={false}
                rel="noreferrer"
                target="_blank"
              >
                Open source draft
                <span className="sr-only"> (opens in a new tab)</span>
              </Link>
            )}
          </div>
          <details>
            <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-foreground">
              View saved source
            </summary>
            <pre
              className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[4px] border border-border bg-sheet p-3 font-mono text-xs text-foreground [overflow-wrap:anywhere]"
              tabIndex={0}
            >
              {JSON.stringify(selectedDocument.source, null, 2)}
            </pre>
          </details>
        </div>
      )}
      {candidateTests}
      <DestructiveConfirmationDialog
        actionDisabled={!canConfirm || busy}
        actionLabel="Activate revision"
        description="Future sessions will use this revision. Existing sessions keep their pinned configuration."
        errorMessage={rollbackError}
        onConfirm={() => void confirmRollback()}
        onOpenChange={(open) => {
          setRollbackError(null);
          setConfirmation(
            open && allowRollback && activationEligible
              ? {
                  revisionId: selectedDocument.id,
                  revisionDigest: selectedDocument.digest,
                  activationNumber: activeActivationNumber,
                }
              : null,
          );
        }}
        open={confirmation !== null}
        pending={rollbackPending}
        pendingLabel="Activating…"
        restoreFocusRef={headingRef}
        title="Activate this revision?"
        trigger={
          allowRollback ? (
            <button
              className="ui-button min-h-11"
              disabled={controlsDisabled || !activationEligible}
              type="button"
            >
              Roll back to this revision
            </button>
          ) : undefined
        }
      >
        {confirmation && (
          <dl className="mt-4 space-y-2 text-xs">
            <div>
              <dt className="text-muted">Current activation</dt>
              <dd className="font-mono text-foreground">#{confirmation.activationNumber}</dd>
            </div>
            <div>
              <dt className="text-muted">Selected revision digest</dt>
              <dd className="font-mono text-foreground [overflow-wrap:anywhere]">
                {confirmation.revisionDigest}
              </dd>
            </div>
          </dl>
        )}
      </DestructiveConfirmationDialog>
    </section>
  );
}
