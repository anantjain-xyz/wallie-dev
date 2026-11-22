import Link from "next/link";
import { useId, useState, type RefObject } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FactoryEditorDocument } from "@/lib/factory-definitions/editor-contracts";
import {
  routingCanarySelectionSchema,
  type RoutingCanarySelection,
} from "@/lib/model-routing/canary-contracts";

import { routingDraftEvidenceHrefs } from "./routing-draft-evidence";

export type ReviewedRoutingActivationTarget = {
  activationNumber: number;
  draftId: string;
  digest: string;
  canary?: RoutingCanarySelection;
};

const evidenceLink = "text-accent underline underline-offset-2";

export function ReviewedRoutingActivation({
  activationNumber,
  baselineAvailable,
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
  baselineAvailable: boolean;
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
  const [rollout, setRollout] = useState<"all" | "canary">("all");
  const [taskClassId, setTaskClassId] = useState("");
  const [candidateShare, setCandidateShare] = useState("");
  const rolloutName = useId();
  const matchesDraft = target?.draftId === draft.id && target.digest === draft.digest;
  const policy = draft.source.modelRouting;
  const reviewedRule = policy?.rules.find(({ id }) => id === draft.routingDraftEvidence?.ruleId);
  const canaryClasses =
    policy?.taskClasses.filter(
      ({ id, slug }) => reviewedRule?.taskClassId === id && draft.source.stages[0]?.slug === slug,
    ) ?? [];
  const canaryAvailable = baselineAvailable && canaryClasses.length > 0;
  const canaryMode = rollout === "canary";
  const shareBps = /^(?:\d{1,2}(?:\.\d{1,2})?|\.\d{1,2})$/.test(candidateShare)
    ? Math.round(Number(candidateShare) * 100)
    : null;
  const canary =
    canaryMode && canaryAvailable && canaryClasses.some(({ id }) => id === taskClassId)
      ? routingCanarySelectionSchema.safeParse({ taskClassId, candidateBps: shareBps })
      : null;
  const canActivate =
    eligible &&
    matchesDraft &&
    target.activationNumber === activationNumber &&
    (!canaryMode || canary?.success === true);
  const evidence = matchesDraft ? draft.routingDraftEvidence : undefined;
  const hrefs = evidence ? routingDraftEvidenceHrefs({ evidence, factoryId, workspaceSlug }) : null;

  async function confirm() {
    if (!canActivate || pending) return;
    setErrorMessage(null);
    try {
      await onActivate({ ...target, ...(canary?.success ? { canary: canary.data } : {}) });
      setTarget(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not activate routing.");
    }
  }

  return (
    <DestructiveConfirmationDialog
      actionDisabled={!canActivate}
      actionLabel={canaryMode ? "Start routing canary" : "Activate routing for new sessions"}
      description={
        canaryMode
          ? "The candidate share applies only to new sessions in the selected task class. Existing sessions keep their pinned decisions."
          : "New sessions will use this routing policy. Existing sessions keep their pinned decisions."
      }
      errorMessage={errorMessage}
      onConfirm={() => void confirm()}
      onOpenChange={(open) => {
        setErrorMessage(null);
        setRollout("all");
        setTaskClassId("");
        setCandidateShare("");
        setTarget(
          open && eligible ? { activationNumber, draftId: draft.id, digest: draft.digest } : null,
        );
      }}
      open={target !== null}
      pending={pending}
      pendingLabel={canaryMode ? "Starting canary…" : "Activating routing…"}
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
          <fieldset
            disabled={pending}
            className="min-w-0 space-y-2 rounded-md border border-border p-3 text-sm"
          >
            <legend className="px-1 font-medium">Rollout</legend>
            <label className="flex min-h-9 items-center gap-2">
              <input
                checked={!canaryMode}
                className="size-4 accent-accent"
                name={rolloutName}
                onChange={() => setRollout("all")}
                type="radio"
              />
              All new sessions
            </label>
            <label className="flex min-h-9 items-center gap-2">
              <input
                checked={canaryMode}
                className="size-4 accent-accent"
                disabled={!canaryAvailable}
                name={rolloutName}
                onChange={() => setRollout("canary")}
                type="radio"
              />
              Canary rollout
            </label>
            {!canaryAvailable ? (
              <p className="type-secondary text-muted">
                A canary requires a compatible baseline and retained evidence for the first stage’s
                routing rule.
              </p>
            ) : null}
            {canaryMode ? (
              <div className="grid min-w-0 gap-3 border-t border-border pt-3">
                <label className="block min-w-0 space-y-1.5">
                  <span className="block font-medium">Canary task class</span>
                  <select
                    className="ui-select"
                    onChange={(event) => setTaskClassId(event.target.value)}
                    value={taskClassId}
                  >
                    <option value="">Choose a task class</option>
                    {canaryClasses.map(({ id, name, slug }) => (
                      <option key={id} value={id}>
                        {name} ({slug})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block min-w-0 space-y-1.5">
                  <span className="block font-medium">Candidate share (%)</span>
                  <input
                    className="ui-input"
                    min="0.01"
                    max="99.99"
                    step="0.01"
                    type="number"
                    onChange={(event) => setCandidateShare(event.target.value)}
                    value={candidateShare}
                  />
                </label>
                <p className="type-secondary text-muted">
                  Enter 0.01% to 99.99%. The other matching sessions use the baseline.
                </p>
              </div>
            ) : null}
          </fieldset>
        </div>
      ) : null}
    </DestructiveConfirmationDialog>
  );
}
