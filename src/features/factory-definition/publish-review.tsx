import Link from "next/link";
import { useState, type ReactNode } from "react";

import { formatUtcTimestamp } from "@/components/shared/time-format";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { CandidateSmokeTest } from "@/lib/factory-definitions/candidate-smoke-contracts";
import type { FactoryEditorDocument } from "@/lib/factory-definitions/editor-contracts";

export type PublishTarget = {
  draftId: string;
  digest: string;
  activationNumber: number;
  testId: string;
};

export function PublishReview({
  activationNumber,
  draft,
  passingTest,
  testHref,
  pending,
  reason,
  diff,
  changeCount,
  onPublish,
}: {
  activationNumber: number;
  draft: FactoryEditorDocument;
  passingTest: CandidateSmokeTest | undefined;
  testHref?: string;
  pending: boolean;
  reason: string | null;
  diff: ReactNode;
  changeCount: number;
  onPublish: (target: PublishTarget) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState<PublishTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const shadow = Boolean(draft.source.modelRouting);
  const effect = shadow
    ? "New sessions use this definition. Routing records what it would choose without changing the execution profile. Existing sessions keep their pinned configuration."
    : "New sessions use this definition. Existing sessions keep their pinned configuration.";
  const ready = !reason && Boolean(passingTest);
  const matches =
    confirmation?.draftId === draft.id &&
    confirmation.digest === draft.digest &&
    confirmation.activationNumber === activationNumber &&
    confirmation.testId === passingTest?.id;
  const changes = `${changeCount} changed ${changeCount === 1 ? "setting or stage" : "settings or stages"}`;
  return (
    <section
      aria-label="Publish saved draft"
      className="min-w-0 space-y-3 border-t border-border pt-4"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">
          Saved draft · <span className="font-mono">{draft.digest.slice(0, 12)}</span>
        </p>
        <p className="type-secondary text-muted">{effect}</p>
        {passingTest && testHref ? (
          <Link
            className="text-sm text-accent underline underline-offset-2"
            href={testHref}
            target="_blank"
            rel="noreferrer"
          >
            Passing configuration test ·{" "}
            {formatUtcTimestamp(passingTest.finishedAt ?? passingTest.createdAt)}
            <span className="sr-only"> (opens in a new tab)</span>
          </Link>
        ) : null}
        {reason ? (
          <p className="type-secondary text-muted">
            {reason}{" "}
            <a className="text-accent underline underline-offset-2" href="#saved-draft-tests">
              Go to configuration tests
            </a>
          </p>
        ) : null}
      </div>
      <details
        className="min-w-0 space-y-3"
        onToggle={(event) => setDiffOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer py-2 text-sm font-medium">
          Compare saved draft · {changes}
        </summary>
        {diffOpen ? diff : null}
      </details>
      <DestructiveConfirmationDialog
        actionDisabled={!ready || !matches}
        actionLabel={shadow ? "Publish in shadow mode" : "Publish draft"}
        description={effect}
        errorMessage={error}
        onConfirm={() => {
          if (!ready || !matches || !confirmation) return;
          void onPublish(confirmation).then(
            () => setConfirmation(null),
            (cause: unknown) =>
              setError(cause instanceof Error ? cause.message : "Could not publish this draft."),
          );
        }}
        onOpenChange={(open) => {
          setError(null);
          setConfirmation(
            open && ready && passingTest
              ? {
                  draftId: draft.id,
                  digest: draft.digest,
                  activationNumber,
                  testId: passingTest.id,
                }
              : null,
          );
        }}
        open={Boolean(confirmation)}
        pending={pending}
        pendingLabel="Publishing…"
        title="Publish this saved draft?"
        trigger={
          <button className="ui-button" disabled={!ready || pending} type="button">
            Review and publish saved draft
          </button>
        }
      >
        {confirmation ? (
          <dl className="mt-4 space-y-2 text-xs">
            <div>
              <dt className="text-muted">Saved draft digest</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">{confirmation.digest}</dd>
            </div>
            <div>
              <dt className="text-muted">Compared with</dt>
              <dd>
                {confirmation.activationNumber
                  ? `Published activation #${confirmation.activationNumber}`
                  : "No published definition"}{" "}
                · {changes}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Passing configuration test</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">{confirmation.testId}</dd>
            </div>
          </dl>
        ) : null}
      </DestructiveConfirmationDialog>
    </section>
  );
}
