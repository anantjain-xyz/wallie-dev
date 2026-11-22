import Link from "next/link";

import { Status } from "@/components/ui/status";
import type {
  RoutingCanaryArmMetrics,
  RoutingCanaryReport,
} from "@/lib/model-routing/canary-report";
import { workspaceFactoryDefinitionPath } from "@/lib/routes";

import { durationLabel, moneyFormat, numberFormat, timeLabel } from "./analytics-view-shared";
import { RoutingCanaryAlertEvidence } from "./routing-canary-alert-evidence";
import type { RoutingCanaryComparisonState } from "./routing-canary-data";

const reasonLabels = {
  insufficient_enrollment: "Too few sessions were assigned to one or both groups.",
  insufficient_quality: "Too few sessions have a usable score.",
  insufficient_spend: "Too few sessions have complete spend measurements.",
  insufficient_latency: "Too few sessions have measured latency.",
  incomparable_scores: "Scorer evidence differs between groups or is unavailable.",
  incomplete_usage: "Some attempts have unavailable or pending costs.",
  exposure_deviations:
    "Some sessions have a routing override, a fallback, or missing or mismatched execution evidence.",
} satisfies Record<RoutingCanaryReport["reasons"][number], string>;

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });
const count = (value: number) => numberFormat.format(value);
const money = (value: number | null) =>
  value === null ? "Unavailable" : moneyFormat.format(value);

type MetricDisplay = { value: string; coverage: string };
type Metric = { label: string; show: (arm: RoutingCanaryArmMetrics) => MetricDisplay };

const metrics: Metric[] = [
  {
    label: "Assigned sessions",
    show: (arm) => ({
      value: count(arm.assignedSessions),
      coverage: `${count(arm.startedSessions)} started · ${count(arm.assignedSessions - arm.startedSessions)} without a started attempt`,
    }),
  },
  {
    label: "Run attempts",
    show: (arm) => ({
      value: count(arm.startedAttempts),
      coverage: `${count(arm.succeededAttempts)} succeeded · ${count(arm.failedAttempts)} failed · ${count(arm.canceledAttempts)} canceled · ${count(arm.pendingAttempts)} pending`,
    }),
  },
  {
    label: "Scored pass rate",
    show: (arm) => ({
      value: arm.scoredSessions
        ? percent.format(arm.scorePasses / arm.scoredSessions)
        : "Unavailable",
      coverage: `${count(arm.scorePasses)} passed · ${count(arm.scoreFailures)} failed · ${count(arm.unavailableScoreSessions)} without a pass or fail (${count(arm.scorePendingSessions)} pending, ${count(arm.scoreNotSampledSessions)} unsampled, ${count(arm.scoreInconclusiveSessions)} inconclusive)`,
    }),
  },
  {
    label: "Known spend",
    show: (arm) => ({
      value: money(arm.knownSpendUsd),
      coverage: `${count(arm.measuredCostAttempts)} measured attempts · ${count(arm.estimatedCostAttempts)} estimated · ${count(arm.unavailableCostAttempts)} unavailable · ${count(arm.pendingCostAttempts)} pending`,
    }),
  },
  {
    label: "Mean spend per complete session",
    show: (arm) => ({
      value: money(arm.meanSpendUsd),
      coverage: `${count(arm.completeSpendSessions)} sessions with complete spend`,
    }),
  },
  {
    label: "Mean attempt wall time per session",
    show: (arm) => ({
      value: arm.meanLatencyMs === null ? "Unavailable" : durationLabel(arm.meanLatencyMs / 1_000),
      coverage: `${count(arm.knownLatencySessions)} measured · ${count(arm.assignedSessions - arm.knownLatencySessions)} unavailable`,
    }),
  },
  {
    label: "Routing evidence",
    show: (arm) => ({
      value: `${count(arm.exposureMismatchSessions)} unverified or mismatched`,
      coverage: `${count(arm.overriddenSessions)} overrides · ${count(arm.fallbackSessions)} fallbacks`,
    }),
  },
];

function MetricCell({ value, coverage }: MetricDisplay) {
  return (
    <td className="break-words px-3 py-3 align-top sm:px-5">
      <p className="font-medium tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted">{coverage}</p>
    </td>
  );
}

function CohortTitle({
  name,
  activationNumber,
  revisionId,
  href,
}: {
  name: string;
  activationNumber: number;
  revisionId: string;
  href?: string;
}) {
  const revision = `Activation #${activationNumber}`;
  return (
    <>
      {name}
      {href ? (
        <Link
          className="mt-1 block text-xs font-normal text-accent underline underline-offset-2"
          href={href}
          prefetch={false}
        >
          {revision}
        </Link>
      ) : (
        <span className="mt-1 block text-xs font-normal text-muted">{revision}</span>
      )}
      <code className="type-annotation mt-1 block break-all font-normal text-muted">
        {revisionId}
      </code>
    </>
  );
}

export function RoutingCanaryComparison({
  canManageFactory,
  factoryId,
  latestAlertHref,
  liveReportHref,
  state,
  workspaceSlug,
}: {
  canManageFactory?: boolean;
  factoryId: string;
  latestAlertHref?: string;
  liveReportHref?: string;
  state: RoutingCanaryComparisonState;
  workspaceSlug: string;
}) {
  if (state.kind === "unavailable") {
    return (
      <section
        id="routing-canary"
        aria-labelledby="routing-canary-title"
        className="ui-sheet space-y-2 px-4 py-4 sm:px-6"
      >
        <h2 id="routing-canary-title" className="type-section-title">
          Routing canary
        </h2>
        <p className="type-secondary text-muted">
          {state.alertRequested
            ? "This retained routing alert is unavailable."
            : "This canary comparison is unavailable."}
        </p>
      </section>
    );
  }
  const report = state.kind === "retained" ? state.alert.report : state.report;
  const { baseline, candidate, canary, outsideClassSessions, reasons, status, window } = report;
  const baselineHref = canManageFactory
    ? `${workspaceFactoryDefinitionPath(workspaceSlug, {
        factory: factoryId,
        revision: canary.baselineRevisionId,
        activation: canary.baselineActivationNumber,
      })}#revision-history`
    : undefined;
  const candidateHref = canManageFactory
    ? `${workspaceFactoryDefinitionPath(workspaceSlug, {
        factory: factoryId,
        revision: canary.candidateRevisionId,
        activation: canary.activationNumber,
      })}#revision-history`
    : undefined;

  return (
    <section
      id="routing-canary"
      aria-labelledby="routing-canary-title"
      className="ui-sheet min-w-0"
    >
      <header className="space-y-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="routing-canary-title" className="type-section-title">
            Routing canary
          </h2>
          {status === "comparable" ? (
            <Status label="Comparable" value="complete" compact />
          ) : (
            <Status label="Inconclusive" value="needs_attention" compact />
          )}
        </div>
        <p className="type-secondary break-words">
          {canary.taskClassSlug} · {percent.format(canary.candidateBps / 10_000)} candidate share
          target
        </p>
        <p className="text-xs text-muted">
          {timeLabel(window.from)} to {timeLabel(window.to)}. Observed as of{" "}
          {timeLabel(window.asOf)}.
        </p>
        <p className="type-secondary text-muted">
          Minimum support of {count(canary.minimumSupport)} sessions per group.{" "}
          {count(outsideClassSessions)} sessions outside this task class.
        </p>
        {reasons.length ? (
          <ul
            className="type-secondary list-disc space-y-1 pl-5 text-muted"
            aria-label="Comparison limits"
          >
            {reasons.map((reason) => (
              <li key={reason}>{reasonLabels[reason]}</li>
            ))}
          </ul>
        ) : null}
        {state.kind === "ready" && state.latestAlert && latestAlertHref ? (
          <div className="flex flex-wrap items-center gap-3">
            <Status compact label="Routing degradation alert" value="needs_attention" />
            <Link
              className="text-sm text-accent underline underline-offset-2"
              href={latestAlertHref}
              prefetch={false}
            >
              View retained alert evidence
            </Link>
          </div>
        ) : null}
      </header>
      {state.kind === "retained" ? (
        <RoutingCanaryAlertEvidence
          alert={state.alert}
          canManageFactory={canManageFactory}
          factoryId={factoryId}
          liveReportHref={liveReportHref}
          workspaceSlug={workspaceSlug}
        />
      ) : null}
      <table className="type-secondary w-full table-fixed text-left">
        <caption className="sr-only">Baseline and candidate outcomes by assigned group</caption>
        <thead>
          <tr>
            <th className="w-1/4 break-words px-3 py-3 align-top font-medium sm:px-5" scope="col">
              Measure
            </th>
            <th className="break-words px-3 py-3 align-top font-medium sm:px-5" scope="col">
              <CohortTitle
                name="Baseline"
                activationNumber={canary.baselineActivationNumber}
                revisionId={canary.baselineRevisionId}
                href={baselineHref}
              />
            </th>
            <th className="break-words px-3 py-3 align-top font-medium sm:px-5" scope="col">
              <CohortTitle
                name="Candidate"
                activationNumber={canary.activationNumber}
                revisionId={canary.candidateRevisionId}
                href={candidateHref}
              />
            </th>
          </tr>
        </thead>
        <tbody>
          {metrics.map(({ label, show }) => (
            <tr key={label} className="border-t border-border">
              <th className="break-words px-3 py-3 align-top font-medium sm:px-5" scope="row">
                {label}
              </th>
              <MetricCell {...show(baseline)} />
              <MetricCell {...show(candidate)} />
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
