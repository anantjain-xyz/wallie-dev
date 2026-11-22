import Link from "next/link";

import { PageSection } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import type {
  BenchmarkFrontier,
  BenchmarkFrontierCandidate,
} from "@/lib/factory-benchmarks/frontier-contracts";

import { ApplyToRoutingButton, BenchmarkRoutingDraft } from "./benchmark-routing-draft";
import {
  benchmarkCandidateRole,
  benchmarkHarnessNames,
  benchmarkRuntimeNames,
} from "./benchmark-trial-labels";

type Candidate = BenchmarkFrontierCandidate;
type Identity = BenchmarkFrontier["recommendation"]["candidates"][number];
type Point = {
  candidate: Candidate;
  cost: string;
  rate: number;
  recommended: boolean;
};
type MarkerKind = "recommended" | "frontier" | "dominated";

const number = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2,
});

const markerLabels = {
  recommended: "Recommended",
  frontier: "Non-dominated",
  dominated: "Dominated",
} satisfies Record<MarkerKind, string>;

const exclusionLabels = {
  no_scorer: "No frozen scorer selected",
  no_eligible_trials: "No shared eligible trials",
  incomplete_execution: "Incomplete comparable execution",
  incomplete_quality: "Incomplete quality evidence",
  unverified_judge_profile: "Judge profile could not be verified",
  mixed_judge_profile: "Judge profiles differ across scored trials",
  insufficient_samples: "Fewer resolved trials than required",
  unavailable_cost: "Measured cost is unavailable for one or more trials",
  estimated_cost: "One or more trials have estimated cost",
  below_quality_floor: "Below the pass-rate floor",
} satisfies Record<Candidate["exclusions"][number], string>;

const unavailableReasons = {
  lowest_measured_cost: "Lowest measured cost at the applied quality and support thresholds.",
  equal_measured_cost_quality: "Equal measured cost and pass rate at the applied thresholds.",
  no_scorer: "No scorer revision was frozen for this comparison.",
  no_eligible_trials: "There are no shared eligible trials.",
  comparison_in_progress: "Comparable trials or scoring are still in progress.",
  mixed_judge_profile: "Comparable scoring requires the same verified judge profile.",
  no_eligible_candidate: "No configuration meets the applied policy.",
} satisfies Record<BenchmarkFrontier["recommendation"]["reason"], string>;

function usd(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return `$${number.format(BigInt(whole))}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

function rate(value: number) {
  return percent.format(value / 10_000);
}

function candidateLabel(candidate: Identity) {
  const role = benchmarkCandidateRole(candidate.position);
  const harness = benchmarkHarnessNames[candidate.plannedHarness] ?? candidate.plannedHarness;
  return [role, harness, candidate.plannedModel].filter(Boolean).join(" · ");
}

function rowId(key: string) {
  return `frontier-configuration-${key}`;
}

function Constraints({
  frontier,
  action,
  preservedQuery,
}: {
  frontier: BenchmarkFrontier;
  action: string;
  preservedQuery: Readonly<Record<string, string | undefined>>;
}) {
  const { policy, scorer, scorers } = frontier;
  return (
    <div className="space-y-3 px-4 py-4 sm:px-5">
      {scorer ? (
        <form
          action={action}
          method="get"
          className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap"
        >
          {Object.entries(preservedQuery).map(([name, value]) =>
            value === undefined ? null : (
              <input key={name} name={name} type="hidden" value={value} />
            ),
          )}
          <SelectField
            className="col-span-2 sm:min-w-48"
            defaultValue={scorer.id}
            label="Frozen scorer"
            labelClassName="type-label"
            name="scorerRevisionId"
            options={scorers.map(({ id, name, revisionNumber }) => ({
              label: `${name} · r${revisionNumber}`,
              value: id,
            }))}
            wrap
          />
          <label className="type-label grid gap-1.5">
            Quality floor (%)
            <input
              className="ui-input w-full sm:w-32"
              name="qualityFloorPercent"
              type="number"
              min={0}
              max={100}
              step={0.01}
              defaultValue={policy.qualityFloorBps / 100}
              required
            />
          </label>
          <label className="type-label grid gap-1.5">
            Minimum resolved trials
            <input
              className="ui-input w-full sm:w-40"
              name="minResolvedTrials"
              type="number"
              min={2}
              max={10_000}
              defaultValue={policy.minimumResolved}
              required
            />
          </label>
          <button className="ui-button col-span-2 justify-self-start" type="submit">
            Apply constraints
          </button>
        </form>
      ) : null}
      <p className="type-secondary text-muted">
        <span className="font-mono">{policy.revision}</span> · {rate(policy.qualityFloorBps)} pass
        floor · {number.format(policy.minimumResolved)} resolved trials minimum. Cost includes
        measured execution and all attempts of the selected scorer across the same eligible trials.
      </p>
    </div>
  );
}

function Recommendation({ frontier }: { frontier: BenchmarkFrontier }) {
  const { cohort, recommendation } = frontier;
  const { status, candidates, candidateCount, meanCostUsd, passRateBps, reason } = recommendation;
  const heading = {
    recommended: "Recommended configuration",
    tied: "Equally recommended configurations",
    unavailable: "No recommendation",
  }[status];
  return (
    <div className="space-y-2 px-4 py-4 sm:px-5">
      <h3 className="type-label font-semibold">{heading}</h3>
      {candidates.length ? (
        <ul className="type-secondary flex flex-wrap gap-x-4 gap-y-1">
          {candidates.map((candidate) => (
            <li className="break-words font-medium" key={candidate.candidateKey}>
              {candidateLabel(candidate)}
            </li>
          ))}
          {candidateCount > candidates.length ? (
            <li className="text-muted">
              +{number.format(candidateCount - candidates.length)} more
            </li>
          ) : null}
        </ul>
      ) : null}
      <p className="type-secondary text-muted">
        {meanCostUsd !== null && passRateBps !== null
          ? `${usd(meanCostUsd)} per trial · ${rate(passRateBps)} pass rate. `
          : null}
        {unavailableReasons[reason]}
      </p>
      <dl className="type-secondary flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
        {Object.entries({
          "Configurations on frontier": frontier.frontierCount,
          "Shared eligible slots per configuration": cohort.eligibleSlotCount,
          "Matched task revisions": cohort.taskRevisionCount,
          "Planned trials": cohort.plannedTrialCount,
          "Eligible trials": cohort.eligibleTrialCount,
          "Excluded trials": cohort.excludedTrialCount,
        }).map(([label, value]) => (
          <div className="flex gap-1.5" key={label}>
            <dt className="text-muted">{label}</dt>
            <dd>{number.format(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Marker({ kind }: { kind: MarkerKind }) {
  const shape = {
    recommended: "rotate-45 rounded-[2px] border-foreground bg-accent",
    frontier: "rounded-full border-accent bg-accent",
    dominated: "rounded-[2px] border-muted bg-background",
  }[kind];
  return <span aria-hidden="true" className={`block size-3 shrink-0 border-2 ${shape}`} />;
}

function pointKind(points: Point[]): MarkerKind {
  if (points.some(({ recommended }) => recommended)) return "recommended";
  return points.some(({ candidate }) => candidate.status === "frontier") ? "frontier" : "dominated";
}

function plotPoints(items: Candidate[]) {
  const groups = new Map<string, Point[]>();
  for (const candidate of items) {
    const cost = candidate.cost.meanCostUsd;
    const rate = candidate.quality.passRateBps;
    if (candidate.status === "excluded" || cost === null || rate === null) continue;
    const key = `${usd(cost)}:${rate}`;
    const point = {
      candidate,
      cost,
      rate,
      recommended: candidate.isRecommended,
    };
    const group = groups.get(key);
    if (group) group.push(point);
    else groups.set(key, [point]);
  }
  return [...groups.values()];
}

function qualitySpread({ spread }: Candidate) {
  if (spread.minPassRateBps === null || spread.maxPassRateBps === null) return null;
  return `${rate(spread.minPassRateBps)}–${rate(spread.maxPassRateBps)}`;
}

function costSpread({ spread }: Candidate) {
  if (spread.minMeanCostUsd === null || spread.maxMeanCostUsd === null) return null;
  return `${usd(spread.minMeanCostUsd)}–${usd(spread.maxMeanCostUsd)}`;
}

function FrontierChart({ frontier }: { frontier: BenchmarkFrontier }) {
  const groups = plotPoints(frontier.items);
  const pointCount = groups.reduce((count, group) => count + group.length, 0);
  const points = groups.flat();
  const axisMax = points.reduce((largest, { cost, candidate }) => {
    const upper = candidate.spread.maxMeanCostUsd;
    return Math.max(largest, Number(cost), upper === null ? 0 : Number(upper));
  }, 0);
  const maxLabel = points
    .flatMap(({ cost, candidate }) => [cost, candidate.spread.maxMeanCostUsd])
    .find((value) => value !== null && Number(value) === axisMax);
  const x = (value: string) => (axisMax > 0 ? (Number(value) / axisMax) * 100 : 0);

  return (
    <figure className="space-y-2 px-4 py-4 sm:px-5" aria-labelledby="frontier-plot-caption">
      <figcaption className="type-label font-semibold" id="frontier-plot-caption">
        Measured cost and pass rate
      </figcaption>
      {points.length ? (
        <>
          <p className="type-secondary text-muted">
            {number.format(pointCount)} plotted of {number.format(frontier.items.length)}
            {" configurations on this page. Markers link to the table."}
          </p>
          <p className="type-secondary text-muted">Pass rate over shared eligible trials (%)</p>
          <div className="pr-3 pl-12">
            <div className="relative h-38 border-b border-l border-border-strong sm:h-46">
              {[0, 2500, 5000, 7500, 10000].map((tick) => (
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 border-t border-border"
                  style={{ bottom: `${tick / 100}%` }}
                  key={tick}
                >
                  <span className="type-annotation absolute right-full -translate-y-1/2 pr-2 text-muted tabular-nums">
                    {rate(tick)}
                  </span>
                </div>
              ))}
              {frontier.policy.qualityFloorBps > 0 && frontier.policy.qualityFloorBps < 10000 ? (
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 border-t border-dashed border-accent"
                  style={{
                    bottom: `${frontier.policy.qualityFloorBps / 100}%`,
                  }}
                />
              ) : null}
              {points.map(({ candidate, cost, rate }) => {
                const { minPassRateBps, maxPassRateBps, minMeanCostUsd, maxMeanCostUsd } =
                  candidate.spread;
                return (
                  <div aria-hidden="true" key={candidate.candidateKey}>
                    {minPassRateBps !== null && maxPassRateBps !== null ? (
                      <div
                        className="absolute border-l border-muted"
                        style={{
                          left: `${x(cost)}%`,
                          bottom: `${minPassRateBps / 100}%`,
                          height: `${(maxPassRateBps - minPassRateBps) / 100}%`,
                        }}
                      />
                    ) : null}
                    {minMeanCostUsd !== null && maxMeanCostUsd !== null ? (
                      <div
                        className="absolute border-t border-muted"
                        style={{
                          left: `${x(minMeanCostUsd)}%`,
                          bottom: `${rate / 100}%`,
                          width: `${x(maxMeanCostUsd) - x(minMeanCostUsd)}%`,
                        }}
                      />
                    ) : null}
                  </div>
                );
              })}
              {groups.map((group) => {
                const point = group[0];
                const kind = pointKind(group);
                return (
                  <a
                    aria-label={`${group.map(({ candidate }) => candidateLabel(candidate)).join(", ")}, ${usd(point.cost)} per trial, ${rate(point.rate)} pass rate, ${markerLabels[kind]}. View configuration table.`}
                    className="absolute z-10 grid size-7 -translate-x-1/2 translate-y-1/2 place-items-center rounded-sm focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-accent"
                    href={`#${rowId(point.candidate.candidateKey)}`}
                    key={point.candidate.candidateKey}
                    style={{
                      left: `${x(point.cost)}%`,
                      bottom: `${point.rate / 100}%`,
                    }}
                  >
                    <Marker kind={kind} />
                  </a>
                );
              })}
            </div>
            <div
              aria-hidden="true"
              className="type-annotation mt-3 flex justify-between text-muted tabular-nums"
            >
              <span>$0.00</span>
              {axisMax > 0 && maxLabel ? <span>{usd(maxLabel)}</span> : null}
            </div>
          </div>
          <p className="type-secondary text-muted">Mean measured USD per shared eligible trial</p>
          <ul className="type-secondary flex flex-wrap gap-x-4 gap-y-2 text-muted">
            {(["recommended", "frontier", "dominated"] satisfies MarkerKind[])
              .filter((kind) => groups.some((group) => pointKind(group) === kind))
              .map((kind) => (
                <li className="flex items-center gap-2" key={kind}>
                  <Marker kind={kind} />
                  {markerLabels[kind]}
                </li>
              ))}
            {frontier.policy.qualityFloorBps > 0 && frontier.policy.qualityFloorBps < 10000 ? (
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="w-4 border-t border-dashed border-accent" />
                Quality floor
              </li>
            ) : null}
          </ul>
          {points.some(({ candidate }) => qualitySpread(candidate) || costSpread(candidate)) ? (
            <p className="type-secondary text-muted">
              Lines show the observed range across complete repetitions.
            </p>
          ) : null}
        </>
      ) : (
        <p className="type-secondary text-muted">
          This page has no configurations with comparable measured cost and quality.
        </p>
      )}
    </figure>
  );
}

function CandidateRows({
  frontier,
  canApplyRouting = false,
}: {
  frontier: BenchmarkFrontier;
  canApplyRouting?: boolean;
}) {
  return (
    <table className="type-secondary w-full table-fixed text-left tabular-nums">
      <caption className="sr-only">Frontier configuration results</caption>
      <thead>
        <tr className="text-muted">
          <th className="w-[35%] px-2 py-2 pl-4 font-medium sm:px-5" scope="col">
            Configuration
          </th>
          <th className="w-[30%] px-2 py-2 font-medium sm:px-5" scope="col">
            Quality
          </th>
          <th className="w-[35%] px-2 py-2 pr-4 font-medium sm:px-5" scope="col">
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {frontier.items.map((candidate) => {
          const { candidateKey, status, counts, quality, cost, spread, dominatedBy } = candidate;
          const label =
            status === "excluded"
              ? "Excluded from frontier"
              : markerLabels[candidate.isRecommended ? "recommended" : status];
          const observedQualitySpread = qualitySpread(candidate);
          const observedCostSpread = costSpread(candidate);
          return (
            <tr
              className="scroll-mt-10 border-t border-border align-top focus-visible:outline-2 focus-visible:outline-accent"
              id={rowId(candidateKey)}
              key={candidateKey}
              tabIndex={-1}
            >
              <th className="space-y-1 break-words px-2 py-3 pl-4 font-normal sm:px-5" scope="row">
                <span className="block font-medium">{candidateLabel(candidate)}</span>
                <span className="block text-muted">
                  {benchmarkRuntimeNames[candidate.plannedRuntime] ?? candidate.plannedRuntime}
                </span>
                <span className="block font-medium">{label}</span>
                {dominatedBy ? (
                  <span className="block text-muted">
                    Dominated by {candidateLabel(dominatedBy)}
                  </span>
                ) : null}
                {candidate.exclusions.length ? (
                  <ul className="space-y-1 text-muted">
                    {candidate.exclusions.map((reason) => (
                      <li key={reason}>{exclusionLabels[reason]}</li>
                    ))}
                  </ul>
                ) : null}
                <span className="block text-muted">
                  {number.format(counts.eligible)} eligible / {number.format(counts.planned)}{" "}
                  planned
                  {" · "}
                  {number.format(counts.excluded)} excluded
                </span>
                {canApplyRouting && status !== "excluded" && candidate.position !== null ? (
                  <ApplyToRoutingButton
                    candidate={{ key: candidateKey, label: candidateLabel(candidate) }}
                  />
                ) : null}
              </th>
              <td className="space-y-1 break-words px-2 py-3 sm:px-5">
                <p className="font-medium">
                  {quality.passRateBps === null
                    ? "Pass rate unavailable"
                    : `${rate(quality.passRateBps)} pass rate`}
                </p>
                <p className="text-muted">
                  {number.format(counts.pass)} passed /{" "}
                  {number.format(frontier.cohort.eligibleSlotCount)} shared
                </p>
                <p className="text-muted">
                  {number.format(counts.resolved)} resolved · {number.format(counts.unresolved)}{" "}
                  unresolved
                </p>
                {quality.scoredPassRateBps !== null ? (
                  <p className="text-muted">
                    {rate(quality.scoredPassRateBps)} of {number.format(counts.scored)} scored
                  </p>
                ) : null}
                <p className="text-muted">
                  {observedQualitySpread
                    ? `${observedQualitySpread} across ${number.format(spread.qualityRepetitions)} repeats`
                    : "Repeat spread unavailable"}
                </p>
              </td>
              <td className="space-y-1 break-words px-2 py-3 pr-4 sm:px-5">
                <p className="font-medium">
                  {cost.meanCostUsd === null
                    ? "Mean cost unavailable"
                    : `${usd(cost.meanCostUsd)} per trial`}
                </p>
                {cost.measuredUsd !== null ? (
                  <p className="text-muted">
                    {usd(cost.measuredUsd)} measured{" "}
                    {cost.meanCostUsd === null ? "subtotal" : "total"}
                  </p>
                ) : null}
                <p className="text-muted">
                  {number.format(cost.measuredTrials)} measured /{" "}
                  {number.format(frontier.cohort.eligibleSlotCount)} shared
                </p>
                {cost.estimatedTrials > 0 ? (
                  <p className="text-muted">
                    {number.format(cost.estimatedTrials)} estimated
                    {cost.estimatedUsd !== null ? ` · ${usd(cost.estimatedUsd)}` : null}
                  </p>
                ) : null}
                {cost.unavailableTrials > 0 ? (
                  <p className="text-muted">{number.format(cost.unavailableTrials)} unavailable</p>
                ) : null}
                {cost.pendingTrials > 0 ? (
                  <p className="text-muted">{number.format(cost.pendingTrials)} pending</p>
                ) : null}
                {cost.neverStartedTrials > 0 ? (
                  <p className="text-muted">
                    {number.format(cost.neverStartedTrials)} never started
                  </p>
                ) : null}
                <p className="text-muted">
                  {observedCostSpread
                    ? `${observedCostSpread} across ${number.format(spread.costRepetitions)} repeats`
                    : "Repeat spread unavailable"}
                </p>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function BenchmarkComparisonFrontier({
  frontier,
  action,
  preservedQuery,
  firstHref,
  nextHref,
  routingDraft,
}: {
  frontier: BenchmarkFrontier;
  action: string;
  preservedQuery: Readonly<Record<string, string | undefined>>;
  firstHref?: string;
  nextHref?: string;
  routingDraft?: { workspaceId: string; workspaceSlug: string; factoryId: string };
}) {
  return (
    <PageSection anchorId="cost-quality-frontier" title="Cost and quality frontier">
      <div className="ui-sheet min-w-0 divide-y divide-border">
        <Constraints frontier={frontier} action={action} preservedQuery={preservedQuery} />
        <Recommendation frontier={frontier} />
        <FrontierChart frontier={frontier} />
        {frontier.items.length ? (
          routingDraft && frontier.scorer ? (
            <BenchmarkRoutingDraft
              context={{
                ...routingDraft,
                experimentId: frontier.experimentId,
                suiteRevisionId: frontier.suite.revisionId,
                scorerRevisionId: frontier.scorer.id,
                qualityFloorBps: frontier.policy.qualityFloorBps,
                minimumResolved: frontier.policy.minimumResolved,
              }}
            >
              <CandidateRows frontier={frontier} canApplyRouting />
            </BenchmarkRoutingDraft>
          ) : (
            <CandidateRows frontier={frontier} />
          )
        ) : null}
        {firstHref || nextHref ? (
          <nav
            aria-label="Frontier configuration pages"
            className="flex flex-wrap gap-2 px-4 py-3 sm:px-5"
          >
            {firstHref ? (
              <Link className="ui-button" href={firstHref} prefetch={false}>
                First frontier configurations
              </Link>
            ) : null}
            {nextHref ? (
              <Link className="ui-button" href={nextHref} prefetch={false}>
                Next frontier configurations
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </PageSection>
  );
}
