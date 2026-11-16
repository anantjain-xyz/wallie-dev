"use client";

import Link from "next/link";
import { useId } from "react";

import { formatUtcTimestamp } from "@/components/shared/time-format";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Status, type StatusValue } from "@/components/ui/status";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import type { CandidateSmokeTest } from "@/lib/factory-definitions/candidate-smoke-contracts";

type CandidateTestPanelProps = {
  target: CandidateSmokeTest["target"] & { digest: string };
  purpose: "publish" | "rollback" | "history";
  activationNumber: number;
  tests: readonly CandidateSmokeTest[];
  eligibility: { eligible: boolean; reason: string | null; activationNumber: number } | null;
  loading: boolean;
  error: string | null;
  actionError: string | null;
  pending: "start" | "cancel" | null;
  allowStart: boolean;
  disableReason?: string | null;
  onStart: () => void;
  onCancel: (testId: string) => void;
  onRefresh: () => void;
  selectedTestId: string | null;
  selectedTest: CandidateSmokeTest | null;
  evidenceLoading: boolean;
  evidenceError: string | null;
  onSelectTest: (testId: string | null) => void;
  evidenceHref: (testId: string) => string;
};

const testStatus = {
  blocked: { value: "blocked", label: "Blocked" },
  canceled: { value: "canceled", label: "Canceled" },
  failed: { value: "failed", label: "Failed" },
  passed: { value: "complete", label: "Passed" },
  running: { value: "running", label: "Running" },
  unsupported: { value: "needs_attention", label: "Unavailable" },
} satisfies Record<CandidateSmokeTest["status"], { value: StatusValue; label: string }>;

const digestClass = "font-mono text-xs text-foreground [overflow-wrap:anywhere]";
const receiptLinkClass =
  "inline-flex min-h-11 items-center text-xs font-medium text-accent underline underline-offset-2";

const evidenceReasons: Record<string, string> = {
  canceled: "The test was canceled.",
  cleanup_failed: "Sandbox cleanup could not be confirmed.",
  fixture_failed: "The test fixture failed during handoff.",
  invalid_prompt: "A stage prompt could not be rendered.",
  node_unavailable: "The sandbox needs Node.js 22 or later to run this test.",
  profile_mismatch: "The sandbox profile differs from the saved definition.",
  sandbox_unavailable: "The sandbox could not start.",
  timeout: "The test exceeded its time limit.",
};

function ReceiptEvidence({ test }: { test: CandidateSmokeTest }) {
  const { evidence } = test;
  const reason = evidence?.reason && evidenceReasons[evidence.reason];
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Status compact {...testStatus[test.status]} />
        {test.finishedAt && (
          <time className="text-muted" dateTime={test.finishedAt}>
            Finished {formatUtcTimestamp(test.finishedAt)}
          </time>
        )}
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-muted">Receipt ID</dt>
          <dd className={digestClass}>{test.id}</dd>
        </div>
        <div>
          <dt className="text-muted">Test policy</dt>
          <dd>Version {test.policyVersion}</dd>
        </div>
        {evidence?.runtimeProfile && (
          <div>
            <dt className="text-muted">Sandbox</dt>
            <dd>{evidence.runtimeProfile}</dd>
          </div>
        )}
        {evidence?.stageCount !== undefined && evidence.completedStageCount !== undefined && (
          <div>
            <dt className="text-muted">Stages completed</dt>
            <dd>
              {evidence.completedStageCount} of {evidence.stageCount}
            </dd>
          </div>
        )}
      </dl>
      {test.error && <p className="text-danger">{test.error}</p>}
      {reason && <p className="text-muted">{reason}</p>}
      {evidence?.cleanupPending && <p className="text-warning">Sandbox cleanup is pending.</p>}
      {evidence?.stages?.length ? (
        <div className="space-y-2">
          <h4 className="font-medium">Retained stage evidence</h4>
          <ol className="divide-y divide-border">
            {evidence.stages.map(({ stageId, promptDigest }) => (
              <li key={stageId} className="space-y-1 py-2">
                <p className="text-muted">
                  Stage <code className={digestClass}>{stageId}</code>
                </p>
                <p className="text-muted">
                  Prompt digest <code className={digestClass}>{promptDigest}</code>
                </p>
              </li>
            ))}
          </ol>
        </div>
      ) : !evidence && !test.error ? (
        <p className="text-muted">
          {test.status === "running"
            ? "Evidence will be available when the test finishes."
            : "No execution evidence recorded."}
        </p>
      ) : null}
    </div>
  );
}

export function CandidateTestPanel({
  target,
  purpose,
  activationNumber,
  tests,
  eligibility,
  loading,
  error,
  actionError,
  pending,
  allowStart,
  disableReason,
  onStart,
  onCancel,
  onRefresh,
  selectedTestId,
  selectedTest,
  evidenceLoading,
  evidenceError,
  onSelectTest,
  evidenceHref,
}: CandidateTestPanelProps) {
  const headingId = useId();
  const evidenceId = useId();
  const eligibilityId = useId();
  const mutable = purpose !== "history";
  const latest = mutable
    ? tests.find(({ baseActivationNumber }) => baseActivationNumber === activationNumber)
    : tests[0];
  const running = mutable && latest?.status === "running" ? latest : null;
  let readiness = "Checking activation eligibility…";
  if (eligibility && eligibility.activationNumber !== activationNumber) {
    readiness =
      "The active factory revision changed. Reload the definition before testing or activating this candidate.";
  } else if (disableReason) readiness = disableReason;
  else if (error) readiness = "Activation eligibility is unavailable.";
  else if (pending === "start") readiness = "Waiting for the test to start…";
  else if (running) readiness = "Wait for the configuration test to finish.";
  else if (eligibility?.eligible) {
    readiness =
      purpose === "publish"
        ? "Ready to publish this draft."
        : "Ready to roll back to this revision.";
  } else if (eligibility?.reason) readiness = eligibility.reason;

  let status: { value: StatusValue; label: string } = {
    value: "not_started",
    label: loading ? "Loading" : "Not tested",
  };
  if (pending === "start") status = { value: "queued", label: "Queued" };
  else if (error) status = { value: "needs_attention", label: "Unavailable" };
  else if (latest) status = testStatus[latest.status];
  const selected =
    selectedTest?.id === selectedTestId &&
    selectedTest.target.kind === target.kind &&
    selectedTest.target.id === target.id &&
    selectedTest.definitionDigest === target.digest
      ? selectedTest
      : null;

  const evidence = selectedTestId && (
    <div className="mt-3 space-y-3 border-t border-border pt-3" id={evidenceId}>
      <h4 className="text-[13px] font-medium">Test evidence</h4>
      {evidenceLoading && (
        <p className="text-xs text-muted" role="status">
          Loading test evidence…
        </p>
      )}
      {evidenceError && (
        <>
          <InlineActionMessage message={{ kind: "error", text: evidenceError }} />
          <button
            className="ui-button min-h-11"
            onClick={() => onSelectTest(selectedTestId)}
            type="button"
          >
            Retry loading evidence
          </button>
        </>
      )}
      {selected && <ReceiptEvidence test={selected} />}
    </div>
  );

  return (
    <section aria-labelledby={headingId} className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium text-foreground" id={headingId}>
          {target.kind === "draft" ? "Draft configuration tests" : "Revision configuration tests"}
        </h3>
        <span aria-live="polite" aria-atomic="true">
          <Status compact {...status} />
        </span>
      </div>
      <dl className="space-y-1 text-xs">
        <dt className="text-muted">Candidate digest</dt>
        <dd className={digestClass}>{target.digest}</dd>
      </dl>
      {mutable && (
        <p aria-live="polite" className="text-sm text-muted" id={eligibilityId}>
          {readiness}
        </p>
      )}
      {mutable && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            aria-describedby={eligibilityId}
            className="ui-button min-h-11"
            disabled={!allowStart || loading || pending !== null || Boolean(running)}
            onClick={onStart}
            type="button"
          >
            <ActionButtonLabel
              idle={tests.length ? "Retest configuration" : "Run configuration test"}
              pending={pending === "start"}
              pendingLabel="Requesting test…"
            />
          </button>
          {running && (
            <button
              className="ui-button min-h-11"
              disabled={pending !== null}
              onClick={() => onCancel(running.id)}
              type="button"
            >
              <ActionButtonLabel
                idle="Cancel test"
                pending={pending === "cancel"}
                pendingLabel="Canceling…"
              />
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="space-y-2">
          <InlineActionMessage message={{ kind: "error", text: error }} />
          <button
            className="ui-button min-h-11"
            disabled={loading}
            onClick={onRefresh}
            type="button"
          >
            Retry loading tests
          </button>
        </div>
      )}
      {actionError && <InlineActionMessage message={{ kind: "error", text: actionError }} />}
      {tests.length > 0 && (
        <ol
          aria-label="Configuration test receipts"
          className="divide-y divide-border border-y border-border text-xs"
        >
          {tests.map((test) => {
            const timestamp = formatUtcTimestamp(test.createdAt);
            const expanded = selectedTestId === test.id;
            return (
              <li key={test.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <time className="font-medium" dateTime={test.createdAt}>
                        {timestamp}
                      </time>
                      <Status compact {...testStatus[test.status]} />
                    </div>
                    <p className="text-muted">
                      {test.baseActivationNumber === 0
                        ? "Before first activation"
                        : `Based on activation #${test.baseActivationNumber}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3">
                    <button
                      aria-controls={expanded ? evidenceId : undefined}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Hide" : "View"} evidence for test ${test.id.slice(0, 8)} at ${timestamp}`}
                      className={receiptLinkClass}
                      onClick={() => onSelectTest(expanded ? null : test.id)}
                      type="button"
                    >
                      {expanded ? "Hide evidence" : "View evidence"}
                    </button>
                    <Link
                      aria-label={`Open test ${test.id.slice(0, 8)} permalink (opens in a new tab)`}
                      className={receiptLinkClass}
                      href={evidenceHref(test.id)}
                      prefetch={false}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Permalink
                    </Link>
                  </div>
                </div>
                {expanded && evidence}
              </li>
            );
          })}
        </ol>
      )}
      {selectedTestId && !tests.some(({ id }) => id === selectedTestId) && evidence}
    </section>
  );
}
