import Link from "next/link";
import { useState, type RefObject } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FactoryEditorDocument } from "@/lib/factory-definitions/editor-contracts";

import { routingDraftEvidenceHrefs } from "./routing-draft-evidence";

export type ReviewedRoutingActivationTarget = {
  activationNumber: number;
  draftId: string;
  digest: string;
};

const evidenceLink = "text-accent underline underline-offset-2";

export function ReviewedRoutingActivation({
  activationNumber,
  draft,
  eligible,
  factoryId,
  onActivate,
  pending,
  restoreFocusRef,
  testHref,
  workspaceSlug,
}: {
  activationNumber: number;
  draft: FactoryEditorDocument;
  eligible: boolean;
  factoryId?: string;
  onActivate: (target: ReviewedRoutingActivationTarget) => Promise<void>;
  pending: boolean;
  restoreFocusRef: RefObject<HTMLElement | null>;
  testHref?: string;
  workspaceSlug: string;
}) {
  const [target, setTarget] = useState<ReviewedRoutingActivationTarget | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const matchesDraft = target?.draftId === draft.id && target.digest === draft.digest;
  const canActivate = eligible && matchesDraft && target.activationNumber === activationNumber;
  const evidence = matchesDraft ? draft.routingDraftEvidence : undefined;
  const hrefs = evidence ? routingDraftEvidenceHrefs({ evidence, factoryId, workspaceSlug }) : null;

  async function confirm() {
    if (!canActivate || pending) return;
    setErrorMessage(null);
    try {
      await onActivate(target);
      setTarget(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not activate routing.");
    }
  }

  return (
    <DestructiveConfirmationDialog
      actionDisabled={!canActivate}
      actionLabel="Activate routing for new sessions"
      description="New sessions will use this routing policy. Existing sessions keep their pinned decisions."
      errorMessage={errorMessage}
      onConfirm={() => void confirm()}
      onOpenChange={(open) => {
        setErrorMessage(null);
        setTarget(
          open && eligible ? { activationNumber, draftId: draft.id, digest: draft.digest } : null,
        );
      }}
      open={target !== null}
      pending={pending}
      pendingLabel="Activating routing…"
      restoreFocusRef={restoreFocusRef}
      title="Activate reviewed routing?"
      trigger={
        <button className="ui-button-primary" disabled={!eligible} type="button">
          Activate reviewed routing
        </button>
      }
    >
      {target ? (
        <div className="mt-4 space-y-3 text-xs">
          <dl className="grid gap-2">
            <div>
              <dt className="text-muted">Expected activation</dt>
              <dd className="font-mono">#{target.activationNumber}</dd>
            </div>
            <div>
              <dt className="text-muted">Saved routing draft digest</dt>
              <dd className="break-all font-mono">{target.digest}</dd>
            </div>
          </dl>
          {evidence && hrefs ? (
            <div className="space-y-1">
              <p>
                {evidence.taskClassName} · {evidence.qualityPassRateBps / 100}% passed ·{" "}
                {evidence.resolvedTrials} resolved trials
              </p>
              <p>
                {evidence.scorerName} · {evidence.suite.name}
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <Link
                  className={evidenceLink}
                  href={hrefs.comparison}
                  prefetch={false}
                  rel="noreferrer"
                  target="_blank"
                >
                  Exact comparison (opens in a new tab)
                </Link>
                <Link
                  className={evidenceLink}
                  href={hrefs.suite}
                  prefetch={false}
                  rel="noreferrer"
                  target="_blank"
                >
                  Frozen suite (opens in a new tab)
                </Link>
              </div>
            </div>
          ) : null}
          {matchesDraft && testHref ? (
            <Link
              className={evidenceLink}
              href={testHref}
              prefetch={false}
              rel="noreferrer"
              target="_blank"
            >
              Passing configuration test (opens in a new tab)
            </Link>
          ) : null}
        </div>
      ) : null}
    </DestructiveConfirmationDialog>
  );
}
