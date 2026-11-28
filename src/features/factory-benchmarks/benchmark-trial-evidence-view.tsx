import { createHash } from "node:crypto";

import { BackLink } from "@/components/ui/back-link";
import {
  MetadataItem,
  MetadataList,
  PageContainer,
  PageHeader,
  PageSection,
} from "@/components/ui/page-shell";
import { Status, agentRunStatusValue } from "@/components/ui/status";
import { ScoreOutcome, scoreReason, scoreValue } from "@/features/factory-scorers/score-outcome";
import { ReviewUnifiedDiff } from "@/features/sessions/detail/review-unified-diff";
import { BrowserScreenshotInspector } from "@/features/wallie/browser-screenshot-evidence";
import { BrowserVideoInspector } from "@/features/wallie/browser-video-evidence";
import type { RunTranscriptPage } from "@/features/wallie/run-transcript-contracts";
import { RunTranscriptLive } from "@/features/wallie/run-transcript-live";
import type { BenchmarkTrialEvidence as Detail } from "@/lib/factory-benchmarks/trial-evidence-contracts";

import { BenchmarkTrialCitation } from "./benchmark-trial-citation";
import {
  benchmarkCandidateRole,
  benchmarkHarnessNames,
  benchmarkReasonLabel,
  benchmarkRuntimeNames,
  benchmarkTrialStatuses,
} from "./benchmark-trial-labels";
import { BenchmarkTrialRefresh } from "./benchmark-trial-refresh";
import { BenchmarkTrialTranscriptRetry } from "./benchmark-trial-transcript-retry";

type Availability = Detail["source"]["availability"];

function EvidenceState({ availability, missing }: { availability: Availability; missing: string }) {
  return (
    <p className="type-secondary text-muted">
      {availability === "withheld" ? "Workspace evidence policy withholds this content." : missing}
    </p>
  );
}

function ExactDetails({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="rounded-md border border-border px-3 py-2">
      <summary className="type-label cursor-pointer">{label}</summary>
      <MetadataList className="[overflow-wrap:anywhere]">{children}</MetadataList>
    </details>
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
            ? owner
              ? "No browser evidence matches the original run’s accepted commit and tree."
              : "No matching original run is available."
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
  transcript: RunTranscriptPage | "retry" | null;
  endpoint: string;
  comparisonHref: string;
}) {
  const { source, output, task, trial, candidate, frozenInputs, diff, scores, suite } = detail;
  const reason =
    trial.eligibilityReason ?? (trial.reason ? benchmarkReasonLabel(trial.reason) : null);
  const harness = benchmarkHarnessNames[candidate.harness] ?? candidate.harness;
  const role = benchmarkCandidateRole(candidate.position);
  const runtime = benchmarkRuntimeNames[candidate.workerRuntime] ?? candidate.workerRuntime;
  const active = trial.status === "pending" || trial.status === "running";
  const { resultDigest } = output;
  const outputAccepted = output.availability === "available" && resultDigest !== null;
  const outputMissing = active
    ? "Not available yet."
    : trial.status === "succeeded" && source.availability === "unavailable"
      ? "Accepted output is unavailable because the original evidence could not be read."
      : "No accepted output.";
  const transcriptEndpoint = `${endpoint}/transcript`;
  const backLink = (
    <BackLink className="hover:text-foreground" href={comparisonHref} prefetch={false}>
      Back to trial results
    </BackLink>
  );

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title={task.name}
        description={
          <span className="[overflow-wrap:anywhere]">
            {[
              role ?? harness,
              candidate.model,
              `Repetition ${trial.repetition}`,
              `${suite.name} · Revision ${suite.revisionNumber}`,
            ].join(" · ")}
          </span>
        }
        eyebrow={backLink}
        eyebrowAsPlain
        actionsRightOnDesktop
        actions={
          <>
            <span role="status">
              <Status {...benchmarkTrialStatuses[trial.status]} />
            </span>
            <BenchmarkTrialRefresh />
          </>
        }
      />
      <div className="space-y-8">
        <PageSection title="Frozen inputs">
          <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
            {reason ? <p className="type-secondary text-muted">{reason}</p> : null}
            <MetadataList className="[overflow-wrap:anywhere]">
              <MetadataItem label="Task revision" value={`Revision ${task.revisionNumber}`} />
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
                  (source.availability === "withheld"
                    ? "Workspace evidence policy withholds the acceptance criteria."
                    : source.availability === "available"
                      ? "No acceptance criteria were retained for this task revision."
                      : "Acceptance criteria are unavailable for the exact original run.")}
              </p>
              {task.acceptanceTruncated ? (
                <p className="type-secondary mt-1 text-muted">
                  The retained criteria exceed this preview.
                </p>
              ) : null}
            </div>
            <ExactDetails label="Exact input pins">
              <MetadataItem label="Trial ID" value={trial.id} monospace />
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
            </ExactDetails>
          </div>
        </PageSection>

        <PageSection title="Original run evidence">
          <div className="ui-sheet min-w-0 space-y-3 p-4 sm:p-5">
            {source.owner ? (
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="type-label">Original run · Attempt {source.owner.attemptCount}</h3>
                <Status compact value={agentRunStatusValue(source.owner.runStatus)} />
              </div>
            ) : null}
            <ExactBrowserMedia evidence={source} side="original" endpoint={endpoint} />
            {source.owner ? (
              <ExactDetails label="Exact original run details">
                <MetadataItem label="Run ID" monospace value={source.owner.runId} />
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
              </ExactDetails>
            ) : null}
          </div>
        </PageSection>

        <PageSection title="Trial output">
          <div className="ui-sheet min-w-0 space-y-3 p-4 sm:p-5">
            {output.owner ? (
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="type-label">Trial replay · Attempt {output.owner.attemptCount}</h3>
                <Status compact value={agentRunStatusValue(output.owner.runStatus)} />
              </div>
            ) : null}
            {outputAccepted ? (
              <>
                {output.validation ? (
                  <p className="type-secondary">
                    Validation · {benchmarkReasonLabel(output.validation.status)}
                  </p>
                ) : null}
                <ExactBrowserMedia evidence={output} side="output" endpoint={endpoint} />
              </>
            ) : (
              <EvidenceState availability={output.availability} missing={outputMissing} />
            )}
            {output.owner ? (
              <ExactDetails label="Exact trial replay details">
                <MetadataItem label="Run ID" monospace value={output.owner.runId} />
                {output.owner.commitSha ? (
                  <MetadataItem
                    label="Accepted output commit"
                    monospace
                    value={output.owner.commitSha}
                  />
                ) : null}
                {output.owner.treeSha ? (
                  <MetadataItem
                    label="Output validation tree"
                    monospace
                    value={output.owner.treeSha}
                  />
                ) : null}
                {output.resultDigest ? (
                  <MetadataItem label="Result digest" monospace value={output.resultDigest} />
                ) : null}
                {output.validation ? (
                  <MetadataItem label="Validation key" monospace value={output.validation.key} />
                ) : null}
              </ExactDetails>
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
                missing={
                  active
                    ? "Not available yet."
                    : "An exact output diff was not retained for this trial."
                }
              />
            )}
          </div>
        </PageSection>

        {transcript === "retry" && output.owner ? (
          <BenchmarkTrialTranscriptRetry
            key={`${output.owner.runId}:${output.owner.attemptCount}`}
            workspaceId={detail.workspaceId}
            runId={output.owner.runId}
            attemptCount={output.owner.attemptCount}
            endpoint={transcriptEndpoint}
          />
        ) : transcript && transcript !== "retry" ? (
          <RunTranscriptLive
            key={createHash("sha256").update(JSON.stringify(transcript)).digest("hex")}
            workspaceId={detail.workspaceId}
            runId={transcript.runId}
            initialPage={transcript}
            trialEndpoint={transcriptEndpoint}
          />
        ) : (
          <PageSection title="Transcript">
            <div className="ui-sheet p-4 sm:p-5">
              <EvidenceState
                availability={output.availability}
                missing={
                  output.transcriptExpiredAt
                    ? "This transcript expired under the workspace retention policy."
                    : active
                      ? "Not available yet."
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
                      {score.evidenceAvailability === "available" &&
                      resultDigest &&
                      score.evidenceLocations.length ? (
                        <ul className="space-y-2">
                          {score.evidenceLocations.map(({ kind, location }, index) => {
                            const query = new URLSearchParams({
                              resultDigest,
                              scorerRevisionId: score.scorerRevisionId,
                              index: String(index),
                            });
                            const sourceLabel =
                              kind === "artifact" ? "Replay artifact" : "Replay validation report";
                            const label =
                              location.kind === "lines"
                                ? `${sourceLabel} · Lines ${location.startLine}–${location.endLine}`
                                : sourceLabel;
                            const href = `${endpoint}/citation?${query}`;
                            return (
                              <li key={href + label}>
                                <BenchmarkTrialCitation label={label} href={href} />
                              </li>
                            );
                          })}
                        </ul>
                      ) : score.evidenceAvailability === "available" ||
                        (score.evidenceAvailability === "unavailable" &&
                          (score.score || score.explanation)) ? (
                        <p className="type-secondary text-muted">
                          Cited source isn’t viewable here.
                        </p>
                      ) : null}
                      <ExactDetails label="Exact scorer details">
                        <MetadataItem
                          label="Scorer revision ID"
                          monospace
                          value={score.scorerRevisionId}
                        />
                      </ExactDetails>
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
        <nav aria-label="Trial navigation" className="type-secondary text-muted">
          {backLink}
        </nav>
      </div>
    </PageContainer>
  );
}
