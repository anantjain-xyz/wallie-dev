import Link from "next/link";
import type { ReactNode } from "react";

import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import type {
  BenchmarkComparison,
  BenchmarkComparisonTrial,
} from "@/lib/factory-benchmarks/comparison-contracts";

import {
  benchmarkCandidateRole,
  benchmarkHarnessNames,
  benchmarkReasonLabel,
  benchmarkRuntimeNames,
  benchmarkTrialStatuses,
} from "./benchmark-trial-labels";

type Candidate = BenchmarkComparison["candidates"][number];
type Counts = BenchmarkComparison["counts"];
type Spend = BenchmarkComparison["spend"];
type Scorer = BenchmarkComparison["scorers"][number];

const number = new Intl.NumberFormat("en-US");
const datetime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const qualityLabels = {
  pass: "Pass",
  fail: "Fail",
  inconclusive: "Inconclusive",
  skipped: "Skipped",
  error: "Error",
  unavailable: "Unavailable",
  pending: "Pending",
} satisfies Record<BenchmarkComparisonTrial["scores"][number]["status"], string>;

function usd(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const decimals = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `$${number.format(BigInt(whole))}.${decimals}`;
}

function duration(ms: number) {
  return ms < 1_000 ? `${number.format(ms)} ms` : `${number.format(ms / 1_000)} s`;
}

function TrialCounts({ counts }: { counts: Counts }) {
  const tallies: ReadonlyArray<Readonly<Record<string, number>>> = [
    {
      Planned: counts.planned,
      Finished: counts.terminal,
      Pending: counts.pending,
      Running: counts.running,
      Excluded: counts.excluded,
    },
    {
      Eligible: counts.eligible,
      Admitted: counts.admitted,
      Started: counts.started,
      Completed: counts.succeeded,
      Failed: counts.failed,
      "Timed out": counts.timedOut,
      Canceled: counts.canceled,
      Unavailable: counts.unavailable,
    },
  ];
  return (
    <div className="space-y-2 tabular-nums">
      {tallies.map((tally, index) => (
        <dl
          className={
            index
              ? "flex flex-wrap gap-x-4 gap-y-1 text-muted"
              : "flex flex-wrap gap-x-4 gap-y-1 font-medium"
          }
          key={index}
        >
          {Object.entries(tally).map(([label, value]) => (
            <div className="flex gap-1.5" key={label}>
              <dt className="text-muted">{label}</dt>
              <dd>{number.format(value)}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

function SpendBreakdown({ spend }: { spend: Spend }) {
  const { combined, execution, evaluation } = spend;
  const hasKnown = combined.measuredAttemptCount > 0 || combined.estimatedAttemptCount > 0;
  return (
    <div className="space-y-2">
      <p className="type-secondary">
        <span className="font-medium">
          {hasKnown ? `${usd(combined.knownUsd)} known spend` : "No known spend"}
        </span>
        {spend.costUnavailableTrialCount > 0 && (
          <span className="text-muted">
            {" · "}
            {number.format(spend.costUnavailableTrialCount)}{" "}
            {spend.costUnavailableTrialCount === 1 ? "trial has" : "trials have"} unavailable cost
          </span>
        )}
      </p>
      <details>
        <summary className="type-label w-fit cursor-pointer">Spend breakdown</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {[
            { label: "Execution", axis: execution },
            { label: "Evaluation", axis: evaluation },
          ].map(({ label, axis }) => (
            <dl className="space-y-1 text-muted tabular-nums" key={label}>
              <div>
                <dt className="inline font-medium text-foreground">{label}</dt>
                <dd className="ml-2 inline">{usd(axis.knownUsd)} known</dd>
              </div>
              <div>
                <dt className="sr-only">Cost provenance</dt>
                <dd>
                  {usd(axis.measuredUsd)} measured ({axis.measuredAttemptCount}) ·{" "}
                  {usd(axis.estimatedUsd)} estimated ({axis.estimatedAttemptCount})
                </dd>
              </div>
              <div>
                <dt className="sr-only">Unsettled costs</dt>
                <dd>
                  {usd(axis.reservedUsd)} reserved, including {usd(axis.unavailableHoldUsd)} held
                  for unavailable cost
                </dd>
              </div>
              <div>
                <dt className="sr-only">Attempt status</dt>
                <dd>
                  {axis.unavailableAttemptCount} unavailable · {axis.pendingAttemptCount} pending ·{" "}
                  {axis.neverStartedAttemptCount} never started
                </dd>
              </div>
            </dl>
          ))}
        </div>
      </details>
    </div>
  );
}

function PinList({ children }: { children: ReactNode }) {
  return <dl className="mt-2 grid gap-2 [overflow-wrap:anywhere]">{children}</dl>;
}

function Pin({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="type-annotation font-mono">{value}</dd>
    </div>
  );
}

function CandidatePins({ candidate }: { candidate: Candidate }) {
  return (
    <details className="mt-2">
      <summary className="type-label w-fit cursor-pointer">Configuration pins</summary>
      <PinList>
        <Pin label="Configuration key" value={candidate.candidateKey} />
        <Pin label="Definition revision" value={candidate.definitionRevisionId} />
        <Pin label="Definition SHA-256" value={candidate.definitionDigest} />
        <Pin label="Sandbox provider" value={candidate.sandboxProvider} />
        {candidate.sandboxConnectionRevision ? (
          <Pin label="Sandbox connection revision" value={candidate.sandboxConnectionRevision} />
        ) : null}
        {candidate.canonicalModelKey ? (
          <Pin label="Canonical model" value={candidate.canonicalModelKey} />
        ) : null}
        {candidate.qualificationId ? (
          <Pin label="Qualification" value={candidate.qualificationId} />
        ) : null}
        {candidate.toolchain ? <Pin label="Checked toolchain" value={candidate.toolchain} /> : null}
        {candidate.toolchainDigest ? (
          <Pin label="Toolchain SHA-256" value={candidate.toolchainDigest} />
        ) : null}
      </PinList>
    </details>
  );
}

function QualityBreakdown({
  quality,
  scorers,
}: {
  quality: Candidate["quality"];
  scorers: ReadonlyMap<string, Scorer>;
}) {
  if (!quality.length) return <p className="text-muted">No scorers selected</p>;
  return (
    <div>
      <p className="type-label mb-2">Quality</p>
      <ul className="divide-y divide-border">
        {quality.map((dimension) => {
          const scorer = scorers.get(dimension.scorerRevisionId);
          return (
            <li className="space-y-1 py-2 first:pt-0" key={dimension.scorerRevisionId}>
              <p className="font-medium">
                {scorer ? `${scorer.name} · r${scorer.revisionNumber}` : dimension.scorerRevisionId}
              </p>
              <p className="text-muted">
                {dimension.pass} passed / {dimension.denominator} eligible
              </p>
              <dl className="flex flex-wrap gap-x-3 gap-y-1 text-muted tabular-nums">
                {[
                  ["Fail", dimension.fail],
                  ["Inconclusive", dimension.inconclusive],
                  ["Skipped", dimension.skipped],
                  ["Error", dimension.error],
                  ["Unavailable", dimension.unavailable],
                  ["Pending", dimension.pending],
                ].map(([label, value]) => (
                  <div className="flex gap-1" key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Configurations({
  candidates,
  scorers,
  firstHref,
  nextHref,
}: {
  candidates: BenchmarkComparison["candidates"];
  scorers: ReadonlyMap<string, Scorer>;
  firstHref?: string;
  nextHref?: string;
}) {
  return (
    <PageSection anchorId="comparison-configurations" title="Configuration results">
      <div className="ui-sheet min-w-0">
        {candidates.length ? (
          <table className="type-secondary w-full table-fixed text-left [overflow-wrap:anywhere]">
            <caption className="sr-only">Configuration results</caption>
            <thead className="text-muted">
              <tr>
                <th className="w-[41%] px-4 py-3 font-medium sm:w-[32%] sm:px-5" scope="col">
                  Configuration
                </th>
                <th className="px-4 py-3 font-medium sm:px-5" scope="col">
                  Results
                </th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr className="border-t border-border align-top" key={candidate.candidateKey}>
                  <th className="space-y-1 px-4 py-4 font-normal sm:px-5" scope="row">
                    <p className="type-label">
                      {benchmarkCandidateRole(candidate.position) ??
                        benchmarkHarnessNames[candidate.plannedHarness] ??
                        candidate.plannedHarness}
                    </p>
                    {candidate.position !== null ? (
                      <p>
                        {benchmarkHarnessNames[candidate.plannedHarness] ??
                          candidate.plannedHarness}
                      </p>
                    ) : null}
                    <p className="text-muted">{candidate.plannedModel}</p>
                    <p className="text-muted">
                      {benchmarkRuntimeNames[candidate.plannedRuntime] ?? candidate.plannedRuntime}
                    </p>
                    <CandidatePins candidate={candidate} />
                  </th>
                  <td className="space-y-3 px-4 py-4 sm:px-5">
                    <TrialCounts counts={candidate.counts} />
                    <p>
                      {candidate.latency.medianMs !== null
                        ? `Median ${duration(candidate.latency.medianMs)} · `
                        : ""}
                      {candidate.latency.p95Ms !== null
                        ? `p95 ${duration(candidate.latency.p95Ms)} · `
                        : ""}
                      <span className="text-muted">
                        {candidate.latency.sampleCount
                          ? `${candidate.latency.sampleCount} observed ${candidate.latency.sampleCount === 1 ? "timing" : "timings"}`
                          : "No observed latency"}
                      </span>
                    </p>
                    <SpendBreakdown spend={candidate.spend} />
                    <QualityBreakdown quality={candidate.quality} scorers={scorers} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="type-secondary px-4 py-4 text-muted sm:px-5">
            No configurations on this page.
          </p>
        )}
        {firstHref || nextHref ? (
          <nav
            aria-label="Configuration pages"
            className="flex flex-wrap gap-2 border-t border-border px-4 py-3 sm:px-5"
          >
            {firstHref ? (
              <Link className="ui-button" href={firstHref} prefetch={false}>
                First configurations
              </Link>
            ) : null}
            {nextHref ? (
              <Link className="ui-button" href={nextHref} prefetch={false}>
                Next configurations
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </PageSection>
  );
}

function TrialRows({
  rows,
  scorers,
  trialHref,
  firstHref,
  nextHref,
}: {
  rows: BenchmarkComparison["trialRows"];
  trialHref: (trialId: string) => string;
  scorers: ReadonlyMap<string, Scorer>;
  firstHref?: string;
  nextHref?: string;
}) {
  return (
    <PageSection anchorId="comparison-trials" title="Trials">
      <div className="ui-sheet min-w-0">
        {rows.length ? (
          <table className="type-secondary w-full table-fixed text-left [overflow-wrap:anywhere]">
            <caption className="sr-only">Frozen trials</caption>
            <thead className="text-muted">
              <tr>
                <th className="w-[49%] px-4 py-3 font-medium sm:w-[40%] sm:px-5" scope="col">
                  Trial
                </th>
                <th className="px-4 py-3 font-medium sm:px-5" scope="col">
                  Outcome
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((trial) => {
                const status = benchmarkTrialStatuses[trial.status];
                return (
                  <tr className="border-t border-border align-top" key={trial.trialId}>
                    <th className="space-y-1 px-4 py-3 font-normal sm:px-5" scope="row">
                      <Link
                        className="type-label underline decoration-border underline-offset-4 hover:text-accent"
                        href={trialHref(trial.trialId)}
                        prefetch={false}
                      >
                        {trial.task.name}
                        <span className="sr-only">
                          {" · "}
                          {benchmarkCandidateRole(trial.candidatePosition) ??
                            benchmarkHarnessNames[trial.plannedHarness] ??
                            trial.plannedHarness}
                          {" · "}
                          {trial.plannedModel} · Repetition {trial.repetition}
                        </span>
                      </Link>
                      <p className="text-muted">
                        {[
                          benchmarkCandidateRole(trial.candidatePosition),
                          benchmarkHarnessNames[trial.plannedHarness] ?? trial.plannedHarness,
                          trial.plannedModel,
                          `Repetition ${trial.repetition}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <details>
                        <summary className="type-label w-fit cursor-pointer">Trial pins</summary>
                        <PinList>
                          <Pin label="Trial ID" value={trial.trialId} />
                          <Pin label="Task revision" value={trial.task.revisionId} />
                          <Pin label="Configuration key" value={trial.candidateKey} />
                          <Pin label="Task revision number" value={trial.task.revisionNumber} />
                          <Pin label="Seed" value={trial.seed} />
                          <Pin label="Timeout" value={duration(trial.timeoutMs)} />
                          {trial.runId ? <Pin label="Run ID" value={trial.runId} /> : null}
                          {trial.actualRunner ? (
                            <Pin
                              label="Observed runner"
                              value={trial.actualRunner.runnerRevision}
                            />
                          ) : null}
                          {trial.actualRunner?.workerRuntime ? (
                            <Pin
                              label="Observed runtime"
                              value={trial.actualRunner.workerRuntime}
                            />
                          ) : null}
                          {trial.actualRunner?.modelName ? (
                            <Pin label="Observed model" value={trial.actualRunner.modelName} />
                          ) : null}
                          {trial.resultDigest ? (
                            <Pin label="Result SHA-256" value={trial.resultDigest} />
                          ) : null}
                        </PinList>
                      </details>
                    </th>
                    <td className="space-y-1.5 px-4 py-3 sm:px-5">
                      <Status {...status} />
                      {trial.eligibilityReason ? (
                        <p className="text-muted">{trial.eligibilityReason}</p>
                      ) : null}
                      {trial.reason && trial.reason !== trial.eligibilityReason ? (
                        <p className="text-muted">{benchmarkReasonLabel(trial.reason)}</p>
                      ) : null}
                      {trial.deadlineElapsed && trial.status !== "timed_out" ? (
                        <p className="text-muted">Deadline elapsed</p>
                      ) : null}
                      {trial.wallRuntimeMs !== null ? (
                        <p className="text-muted">{duration(trial.wallRuntimeMs)} observed</p>
                      ) : null}
                      {trial.spend.combined.measuredAttemptCount > 0 ||
                      trial.spend.combined.estimatedAttemptCount > 0 ? (
                        <p>{usd(trial.spend.combined.knownUsd)} known spend</p>
                      ) : null}
                      {trial.spend.costUnavailableTrialCount > 0 ? (
                        <p className="text-muted">Cost unavailable</p>
                      ) : null}
                      {trial.scores.length ? (
                        <details>
                          <summary className="type-label w-fit cursor-pointer">Scores</summary>
                          <ul className="mt-2 space-y-2">
                            {trial.scores.map((score) => {
                              const scorer = scorers.get(score.scorerRevisionId);
                              const label = scorer
                                ? `${scorer.name} · r${scorer.revisionNumber}`
                                : score.scorerRevisionId;
                              return (
                                <li key={score.scorerRevisionId}>
                                  <p>
                                    {label} · {qualityLabels[score.status]}
                                    {score.score ? ` · ${String(score.score.value)}` : null}
                                  </p>
                                  {score.reason ? (
                                    <p className="text-muted">
                                      {benchmarkReasonLabel(score.reason)}
                                    </p>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="type-secondary px-4 py-4 text-muted sm:px-5">No trials on this page.</p>
        )}
        {firstHref || nextHref ? (
          <nav
            aria-label="Trial pages"
            className="flex flex-wrap gap-2 border-t border-border px-4 py-3 sm:px-5"
          >
            {firstHref ? (
              <Link className="ui-button" href={firstHref} prefetch={false}>
                First trials
              </Link>
            ) : null}
            {nextHref ? (
              <Link className="ui-button" href={nextHref} prefetch={false}>
                Next trials
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </PageSection>
  );
}

export function BenchmarkComparisonResults({
  comparison,
  trialHref,
  firstTrialsHref,
  nextTrialsHref,
  firstConfigurationsHref,
  nextConfigurationsHref,
}: {
  comparison: BenchmarkComparison;
  trialHref: (trialId: string) => string;
  firstTrialsHref?: string;
  nextTrialsHref?: string;
  firstConfigurationsHref?: string;
  nextConfigurationsHref?: string;
}) {
  const { counts, candidates, scorers, spend, suite } = comparison;
  const scorerByRevision = new Map(scorers.map((scorer) => [scorer.id, scorer]));

  return (
    <>
      <PageSection title="Comparison summary">
        <div className="ui-sheet type-secondary divide-y divide-border">
          <div className="space-y-3 px-4 py-4 sm:px-5">
            <TrialCounts counts={counts} />
            <SpendBreakdown spend={spend} />
          </div>
          <div className="px-4 py-4 sm:px-5">
            <MetadataList>
              <MetadataItem label="Suite revision" value={`Revision ${suite.revisionNumber}`} />
              <MetadataItem
                label="Schedule"
                value={benchmarkReasonLabel(comparison.scheduleState)}
              />
              <MetadataItem label="Repetitions" value={comparison.repetitions} />
              <MetadataItem label="Configurations" value={comparison.candidateCount} />
              <MetadataItem
                label="Frozen at"
                value={
                  <time dateTime={comparison.createdAt}>
                    {datetime.format(new Date(comparison.createdAt))} UTC
                  </time>
                }
              />
              <MetadataItem label="Seed" value={comparison.seed} />
              <MetadataItem label="Trial timeout" value={duration(comparison.timeoutMs)} />
            </MetadataList>
            <details className="mt-3">
              <summary className="type-label w-fit cursor-pointer">Frozen revisions</summary>
              <PinList>
                <Pin label="Suite revision ID" value={suite.revisionId} />
                <Pin label="Experiment ID" value={comparison.experimentId} />
                <Pin label="Replay policy revision" value={comparison.policyRevisionId} />
                <Pin label="Replay policy SHA-256" value={comparison.policyDigest} />
                {scorers.map((scorer) => (
                  <Pin
                    key={scorer.id}
                    label={`${scorer.name} · r${scorer.revisionNumber}`}
                    value={`${scorer.id} · SHA-256 ${scorer.definitionDigest}`}
                  />
                ))}
              </PinList>
              {!scorers.length ? <p className="mt-2 text-muted">No scorers selected</p> : null}
            </details>
          </div>
        </div>
      </PageSection>
      <Configurations
        candidates={candidates}
        scorers={scorerByRevision}
        firstHref={firstConfigurationsHref}
        nextHref={nextConfigurationsHref}
      />
      <TrialRows
        rows={comparison.trialRows}
        trialHref={trialHref}
        scorers={scorerByRevision}
        firstHref={firstTrialsHref}
        nextHref={nextTrialsHref}
      />
    </>
  );
}
