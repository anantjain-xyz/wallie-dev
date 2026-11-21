import Link from "next/link";

import {
  MetadataItem,
  MetadataList,
  PageContainer,
  PageHeader,
  PageSection,
} from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { ScoreOutcome, scoreReason, scoreValue } from "@/features/factory-scorers/score-outcome";
import { ReviewUnifiedDiff } from "@/features/sessions/detail/review-unified-diff";
import { BrowserScreenshotInspector } from "@/features/wallie/browser-screenshot-evidence";
import { BrowserVideoInspector } from "@/features/wallie/browser-video-evidence";
import type { RunTranscriptPage } from "@/features/wallie/run-transcript-contracts";
import { RunTranscriptLive } from "@/features/wallie/run-transcript-live";
import type { BenchmarkTrialEvidence as Detail } from "@/lib/factory-benchmarks/trial-evidence-contracts";

import {
  benchmarkCandidateRole,
  benchmarkHarnessNames,
  benchmarkReasonLabel,
  benchmarkRuntimeNames,
  benchmarkTrialStatuses,
} from "./benchmark-trial-labels";

type Availability = Detail["source"]["availability"];

function EvidenceState({ availability, missing }: { availability: Availability; missing: string }) {
  return (
    <p className="type-secondary text-muted">
      {availability === "withheld" ? "Workspace evidence policy withholds this content." : missing}
    </p>
  );
}

function ExactBrowserMedia({
  evidence,
  side,
  endpoint,
}: {
  evidence: Detail["source"] | Detail["output"];
  side: "original" | "output";
  endpoint: string;
}) {
  const { owner, mediaPlanMatched } = evidence;
  if (!owner || !mediaPlanMatched || !owner.commitSha || !owner.treeSha) {
    return (
      <EvidenceState
        availability={evidence.availability}
        missing={
          side === "original"
            ? "No browser evidence matches the original run’s accepted commit and tree."
            : "No browser evidence matches this trial’s accepted output commit and tree."
        }
      />
    );
  }

  const trial = {
    endpoint: `${endpoint}/media/${side}`,
    side,
    runId: owner.runId,
    attemptCount: owner.attemptCount,
    commitSha: owner.commitSha,
    treeSha: owner.treeSha,
  };
  return (
    <div className="min-w-0 space-y-2">
      <BrowserScreenshotInspector trial={trial} />
      <BrowserVideoInspector trial={trial} />
    </div>
  );
}

export function BenchmarkTrialEvidenceView({
  detail,
  transcript,
  endpoint,
  comparisonHref,
}: {
  detail: Detail;
  transcript: RunTranscriptPage | null;
  endpoint: string;
  comparisonHref: string;
}) {
  const { source, output, task, trial, candidate, frozenInputs, diff, scores, suite } = detail;
  const reason =
    trial.eligibilityReason ?? (trial.reason ? benchmarkReasonLabel(trial.reason) : null);
  const harness = benchmarkHarnessNames[candidate.harness] ?? candidate.harness;
  const role = benchmarkCandidateRole(candidate.position);
  const runtime = benchmarkRuntimeNames[candidate.workerRuntime] ?? candidate.workerRuntime;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title={task.name}
        description={`${suite.name} · Revision ${suite.revisionNumber} · Repetition ${trial.repetition}`}
        eyebrow={
          <Link className="hover:text-foreground" href={comparisonHref}>
            ← Comparison results
          </Link>
        }
        eyebrowAsPlain
        actionsRightOnDesktop
        actions={<Status {...benchmarkTrialStatuses[trial.status]} />}
      />
      <div className="space-y-8">
        <PageSection title="Frozen inputs">
          <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
            {reason ? <p className="type-secondary text-muted">{reason}</p> : null}
            <MetadataList className="[overflow-wrap:anywhere]">
              <MetadataItem label="Task revision" value={`Revision ${task.revisionNumber}`} />
              <MetadataItem label="Trial ID" value={trial.id} monospace />
              <MetadataItem label="Configuration" value={role ? `${role} · ${harness}` : harness} />
              <MetadataItem label="Model" value={candidate.model} monospace />
              <MetadataItem label="Worker runtime" value={runtime} />
              <MetadataItem
                label="Original checkout"
                value={frozenInputs.checkoutSha ?? "Unavailable"}
                monospace={frozenInputs.checkoutSha !== null}
              />
              <MetadataItem label="Seed" value={trial.seed} />
              <MetadataItem label="Timeout" value={`${trial.timeoutMs / 1_000} s`} />
            </MetadataList>
            <div>
              <h3 className="type-label mb-1">Acceptance criteria</h3>
              <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
                {task.acceptanceCriteria ??
                  "Workspace evidence policy withholds the acceptance criteria."}
              </p>
              {task.acceptanceTruncated ? (
                <p className="type-secondary mt-1 text-muted">
                  The retained criteria exceed this preview.
                </p>
              ) : null}
            </div>
            <details className="rounded-md border border-border px-3 py-2">
              <summary className="type-label cursor-pointer">Exact input pins</summary>
              <MetadataList className="[overflow-wrap:anywhere]">
                <MetadataItem label="Suite revision ID" monospace value={suite.revisionId} />
                <MetadataItem label="Task revision ID" monospace value={task.revisionId} />
                <MetadataItem label="Configuration key" monospace value={candidate.key} />
                <MetadataItem
                  label="Definition revision"
                  monospace
                  value={candidate.definitionRevisionId}
                />
                <MetadataItem
                  label="Definition digest"
                  monospace
                  value={candidate.definitionDigest}
                />
                <MetadataItem label="Sandbox provider" value={candidate.sandboxProvider} />
                <MetadataItem
                  label="Replay policy revision"
                  monospace
                  value={frozenInputs.policyRevisionId}
                />
                <MetadataItem
                  label="Replay policy digest"
                  monospace
                  value={frozenInputs.policyDigest}
                />
                <MetadataItem
                  label="Input commit"
                  monospace
                  value={frozenInputs.inputSha ?? "Unavailable"}
                />
                {frozenInputs.sourceDefinitionRevisionId ? (
                  <MetadataItem
                    label="Original definition revision"
                    monospace
                    value={frozenInputs.sourceDefinitionRevisionId}
                  />
                ) : null}
                {frozenInputs.sourceDefinitionDigest ? (
                  <MetadataItem
                    label="Original definition digest"
                    monospace
                    value={frozenInputs.sourceDefinitionDigest}
                  />
                ) : null}
                {frozenInputs.contextManifestSha256 ? (
                  <MetadataItem
                    label="Context manifest digest"
                    monospace
                    value={frozenInputs.contextManifestSha256}
                  />
                ) : null}
              </MetadataList>
            </details>
          </div>
        </PageSection>

        <PageSection title="Original run evidence">
          <div className="ui-sheet min-w-0 space-y-3 p-4 sm:p-5">
            {source.owner ? (
              <MetadataList className="[overflow-wrap:anywhere]">
                <MetadataItem label="Original run" monospace value={source.owner.runId} />
                <MetadataItem label="Attempt" value={source.owner.attemptCount} />
                <MetadataItem
                  label="Accepted source commit"
                  monospace
                  value={source.owner.commitSha ?? "Unavailable"}
                />
                <MetadataItem
                  label="Source validation tree"
                  monospace
                  value={source.owner.treeSha ?? "Unavailable"}
                />
              </MetadataList>
            ) : null}
            <ExactBrowserMedia evidence={source} side="original" endpoint={endpoint} />
          </div>
        </PageSection>

        <PageSection title="Trial output">
          <div className="ui-sheet min-w-0 space-y-3 p-4 sm:p-5">
            {output.owner ? (
              <MetadataList className="[overflow-wrap:anywhere]">
                <MetadataItem label="Output run" monospace value={output.owner.runId} />
                <MetadataItem label="Attempt" value={output.owner.attemptCount} />
                <MetadataItem
                  label="Accepted output commit"
                  monospace
                  value={output.owner.commitSha ?? "Unavailable"}
                />
                <MetadataItem
                  label="Output validation tree"
                  monospace
                  value={output.owner.treeSha ?? "Unavailable"}
                />
                {output.resultDigest ? (
                  <MetadataItem label="Result digest" monospace value={output.resultDigest} />
                ) : null}
                {output.validation ? (
                  <MetadataItem
                    label={output.validation.key}
                    value={benchmarkReasonLabel(output.validation.status)}
                  />
                ) : null}
              </MetadataList>
            ) : (
              <EvidenceState
                availability={output.availability}
                missing="This trial has no retained output."
              />
            )}
            {output.owner ? (
              <ExactBrowserMedia evidence={output} side="output" endpoint={endpoint} />
            ) : null}
          </div>
        </PageSection>

        <PageSection title="Output diff">
          <div className="ui-sheet min-w-0 space-y-3 p-4 sm:p-5">
            {diff.availability === "available" && diff.patch !== null ? (
              <>
                <MetadataList className="[overflow-wrap:anywhere]">
                  <MetadataItem
                    label="Replay input commit"
                    monospace
                    value={output.inputCommitSha ?? "Unavailable"}
                  />
                  <MetadataItem
                    label="Accepted output commit"
                    monospace
                    value={output.owner?.commitSha ?? "Unavailable"}
                  />
                </MetadataList>
                {diff.patch ? (
                  <ReviewUnifiedDiff
                    label="Unified diff for this trial output"
                    patch={diff.patch}
                  />
                ) : (
                  <p className="type-secondary text-muted">
                    No code changes between these commits.
                  </p>
                )}
              </>
            ) : (
              <EvidenceState
                availability={diff.availability}
                missing="An exact output diff was not retained for this trial."
              />
            )}
          </div>
        </PageSection>

        {transcript ? (
          <RunTranscriptLive
            workspaceId={detail.workspaceId}
            runId={transcript.runId}
            initialPage={transcript}
            trialEndpoint={`${endpoint}/transcript`}
          />
        ) : (
          <PageSection title="Transcript">
            <div className="ui-sheet p-4 sm:p-5">
              <EvidenceState
                availability={output.availability}
                missing={
                  output.transcriptExpiredAt
                    ? "This transcript expired under the workspace retention policy."
                    : "No retained transcript is available for this trial."
                }
              />
            </div>
          </PageSection>
        )}

        <PageSection title="Scorer explanations">
          <div className="ui-sheet min-w-0">
            {scores.length ? (
              <ul className="divide-y divide-border">
                {scores.map((score) => {
                  const reason =
                    scoreReason(score.reason) ??
                    (score.reason ? benchmarkReasonLabel(score.reason) : null);
                  return (
                    <li className="space-y-2 p-4 sm:p-5" key={score.scorerRevisionId}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="type-label [overflow-wrap:anywhere]">
                          {score.name} · Revision {score.revisionNumber}
                        </h3>
                        {score.status === "unavailable" ? (
                          <Status compact label="Unavailable" value="blocked" />
                        ) : (
                          <ScoreOutcome
                            reason={score.reason}
                            status={score.status === "pending" ? "unsettled" : score.status}
                          />
                        )}
                      </div>
                      {score.score ? (
                        <p className="type-secondary">Score {scoreValue(score.score)}</p>
                      ) : null}
                      {score.explanation ? (
                        <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {score.explanation}
                        </p>
                      ) : null}
                      {reason ? <p className="type-secondary text-muted">{reason}</p> : null}
                      {score.evidenceAvailability === "withheld" ? (
                        <p className="type-secondary text-muted">
                          Supporting evidence was withheld.
                        </p>
                      ) : null}
                      {score.evidenceLocations.length ? (
                        <ul className="type-secondary list-disc space-y-1 pl-4 text-muted">
                          {score.evidenceLocations.map(({ kind, location }, index) => (
                            <li key={index}>
                              {kind === "artifact" ? "Artifact" : "Validation report"}
                              {location.kind === "lines"
                                ? ` · Lines ${location.startLine}–${location.endLine}`
                                : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <p className="type-annotation font-mono text-muted [overflow-wrap:anywhere]">
                        {score.scorerRevisionId}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="type-secondary p-4 text-muted sm:p-5">
                No scorer results are available for this trial.
              </p>
            )}
          </div>
        </PageSection>
      </div>
    </PageContainer>
  );
}
