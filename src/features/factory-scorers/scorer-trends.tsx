import Link from "next/link";

import { PageSection } from "@/components/ui/page-shell";
import type {
  ScoreCohort,
  ScoreMetrics,
  ScoreTrend,
} from "@/lib/factory-evaluations/score-trend-contracts";
import type { ScorerTrendQuery } from "@/lib/factory-evaluations/score-trend-query";
import type { ScoreTrendPanelData } from "@/lib/factory-evaluations/score-trends";
import { workspaceRunDetailPath } from "@/lib/routes";

import { ScoreOutcome, scoreNumber, scoreReasonDetail, scoreValue } from "./score-outcome";

type Fields = Record<string, string | undefined>;

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const calendar = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const linkClass =
  "rounded-sm text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent";

function withFields(path: string, fields: Fields, anchor: string) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value) search.set(key, value);
  return `${path}${search.size ? `?${search}` : ""}#${anchor}`;
}

function HiddenFields({ values }: { values: Fields }) {
  return Object.entries(values).map(([key, value]) =>
    value ? <input key={key} name={key} type="hidden" value={value} /> : null,
  );
}

function cohortLabel(cohort: ScoreCohort) {
  return `Policy ${cohort.policy_revision_number} · ${percent.format(cohort.rate_bps / 10_000)} sampling`;
}

function rate(part: number, total: number) {
  return total > 0 ? percent.format(part / total) : "—";
}

const countColumns = [
  ["candidate_count", "Candidates"],
  ["eligible_count", "Eligible"],
  ["sampled_count", "Sampled"],
  ["usable_count", "Usable"],
  ["decided_count", "Decided"],
  ["pass_count", "Passed"],
  ["fail_count", "Failed"],
] as const satisfies readonly [keyof ScoreMetrics, string][];

function TrendsFigure({ trend, dayHref }: { trend: ScoreTrend; dayHref: (day: string) => string }) {
  const numericMean = trend.totals.mean_numeric_score;
  return (
    <div className="ui-sheet min-w-0 divide-y divide-border">
      <figure aria-label="Scorer pass rate by day" className="space-y-3 px-4 py-4 sm:px-5">
        <figcaption className="type-label font-semibold">Pass rate by day</figcaption>
        {trend.points.length ? (
          <ul className="space-y-2">
            {trend.points.map((point) => {
              const day = point.bucket_at.slice(0, 10);
              const label = calendar.format(new Date(point.bucket_at));
              const passRate = rate(point.pass_count, point.decided_count);
              return (
                <li key={day}>
                  <Link
                    aria-label={`${label}, ${point.pass_count} passed of ${point.decided_count} decided, open cohort results`}
                    className="grid min-w-0 grid-cols-[minmax(5rem,auto)_1fr_auto] items-center gap-3 rounded-sm text-sm focus-visible:outline-2 focus-visible:outline-accent"
                    href={dayHref(day)}
                    prefetch={false}
                  >
                    <span className="text-accent underline underline-offset-4">{label}</span>
                    <span
                      aria-hidden="true"
                      className="bg-accent-soft h-2 min-w-0 overflow-hidden rounded-sm"
                    >
                      <span
                        className="bg-accent block h-full"
                        style={{ width: point.decided_count ? passRate : "0%" }}
                      />
                    </span>
                    <span className="text-muted tabular-nums">
                      {point.pass_count}/{point.decided_count} ({passRate})
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="type-secondary text-muted">No candidate runs in this date range.</p>
        )}
      </figure>
      <div
        aria-label="Scrollable scorer trend table"
        className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-accent"
        role="region"
        tabIndex={0}
      >
        <table className="type-secondary w-full text-left">
          <caption className="sr-only">Scorer trend totals</caption>
          <thead className="text-muted">
            <tr>
              <th className="px-4 py-3 font-medium sm:px-5" scope="col">
                Date (UTC)
              </th>
              {countColumns.map(([key, label]) => (
                <th
                  className="p-2 text-right font-medium last:pr-4 sm:last:pr-5"
                  key={key}
                  scope="col"
                >
                  {label}
                </th>
              ))}
              {numericMean !== null ? (
                <th className="px-4 py-3 text-right font-medium" scope="col">
                  Mean score
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {trend.points.map((point) => (
              <tr className="border-t border-border" key={point.bucket_at}>
                <th className="whitespace-nowrap px-4 py-2 font-medium sm:px-5" scope="row">
                  <Link
                    className={linkClass}
                    href={dayHref(point.bucket_at.slice(0, 10))}
                    prefetch={false}
                  >
                    {calendar.format(new Date(point.bucket_at))}
                  </Link>
                </th>
                {countColumns.map(([key]) => (
                  <td className="p-2 text-right tabular-nums last:pr-4 sm:last:pr-5" key={key}>
                    {scoreNumber.format(point[key])}
                  </td>
                ))}
                {numericMean !== null ? (
                  <td className="px-4 py-2 text-right tabular-nums">
                    {point.mean_numeric_score === null
                      ? "—"
                      : scoreNumber.format(point.mean_numeric_score)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <th className="px-4 py-3 font-semibold sm:px-5" scope="row">
                Total
              </th>
              {countColumns.map(([key]) => (
                <td className="p-2 text-right tabular-nums last:pr-4 sm:last:pr-5" key={key}>
                  {scoreNumber.format(trend.totals[key])}
                </td>
              ))}
              {numericMean !== null ? (
                <td className="px-4 py-2 text-right tabular-nums">
                  {scoreNumber.format(numericMean)}
                </td>
              ) : null}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function TrendCoverage({ totals }: { totals: ScoreMetrics }) {
  const items = [
    {
      label: "Eligible",
      part: totals.eligible_count,
      total: totals.candidate_count,
      denominator: "candidates",
    },
    {
      label: "Sampled",
      part: totals.sampled_count,
      total: totals.eligible_count,
      denominator: "eligible",
    },
    {
      label: "Usable",
      part: totals.usable_count,
      total: totals.sampled_count,
      denominator: "sampled",
    },
    {
      label: "Decided",
      part: totals.decided_count,
      total: totals.usable_count,
      denominator: "usable",
    },
  ];
  return (
    <div className="ui-sheet space-y-3 px-4 py-4 sm:px-5">
      <h3 className="type-label font-semibold">Coverage</h3>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {items.map(({ label, part, total, denominator }) => (
          <div key={label}>
            <dt className="type-secondary text-muted">{label}</dt>
            <dd className="font-semibold tabular-nums">
              {scoreNumber.format(part)}{" "}
              <span className="type-label font-normal text-muted">
                / {scoreNumber.format(total)} {denominator}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="type-secondary text-muted">
        Usable scores include numerical results between thresholds. Decided scores have a pass or
        fail verdict.
      </p>
    </div>
  );
}

const filterOptions = [
  ["pass", "Passed"],
  ["fail", "Failed"],
  ["inconclusive", "Inconclusive"],
  ["error", "Evaluator error"],
  ["skipped", "Skipped"],
  ["unsettled", "Awaiting evaluation"],
  ["not_sampled", "Not sampled"],
  ["excluded", "Excluded"],
] as const;

function CohortRows({
  workspaceSlug,
  trend,
  query,
  path,
  fields,
}: {
  workspaceSlug: string;
  trend: ScoreTrend;
  query: ScorerTrendQuery;
  path: string;
  fields: Fields;
}) {
  const page = {
    ...fields,
    evaluationDay: query.evaluationDay,
    evaluationStatus: query.evaluationStatus,
  };
  return (
    <section
      aria-labelledby="scorer-cohort-results-title"
      className="ui-sheet min-w-0 scroll-mt-24 divide-y divide-border"
      id="scorer-cohort-results"
    >
      <header className="space-y-3 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="type-label font-semibold" id="scorer-cohort-results-title">
            Cohort results
          </h3>
          <p className="type-secondary text-muted">
            {scoreNumber.format(trend.row_count)} matching {trend.row_count === 1 ? "run" : "runs"}
            {query.evaluationDay ? ` · ${calendar.format(new Date(query.evaluationDay))}` : ""}
          </p>
        </div>
        <form
          action={`${path}#scorer-cohort-results`}
          className="flex flex-wrap items-end gap-3"
          method="get"
        >
          <HiddenFields values={{ ...fields, evaluationDay: query.evaluationDay }} />
          <label className="type-label flex flex-col gap-1.5">
            Result state
            <select
              className="ui-input"
              defaultValue={query.evaluationStatus ?? ""}
              name="evaluationStatus"
            >
              <option value="">All states</option>
              {filterOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="ui-button" type="submit">
            Filter results
          </button>
          {query.evaluationDay ? (
            <Link
              className={linkClass}
              href={withFields(
                path,
                { ...page, evaluationDay: undefined },
                "scorer-cohort-results",
              )}
              prefetch={false}
            >
              All dates
            </Link>
          ) : null}
        </form>
      </header>
      {!trend.rows.length ? (
        <p className="type-secondary px-4 py-4 text-muted sm:px-5">No runs match these filters.</p>
      ) : (
        <ul className="divide-y divide-border">
          {trend.rows.map((row) => {
            const url = withFields(
              workspaceRunDetailPath(workspaceSlug, row.run_id),
              { evaluationAttempt: row.evaluation_attempt_id ?? undefined },
              row.evaluation_job_id ? `evaluation-${row.evaluation_job_id}` : "scorer-evaluations",
            );
            const resultReason = row.reason ?? row.sample_reason;
            const reason = scoreReasonDetail(resultReason);
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
                key={row.sample_receipt_id}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <ScoreOutcome reason={row.reason ?? row.sample_reason} status={row.status} />
                    <span className="type-secondary text-muted">
                      {calendar.format(new Date(row.run_finished_at))}
                    </span>
                    {row.target_commit_sha ? (
                      <code className="text-xs text-muted">
                        {row.target_commit_sha.slice(0, 12)}
                      </code>
                    ) : null}
                  </div>
                  {reason || row.score || row.evidence_availability === "withheld" ? (
                    <p className="type-secondary text-muted">
                      {[
                        reason,
                        row.score ? `Score ${scoreValue(row.score)}` : null,
                        row.evidence_availability === "withheld" &&
                        resultReason !== "withheld_evidence"
                          ? "Evidence withheld"
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>
                <Link className="ui-button" href={url} prefetch={false}>
                  Open run
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {query.beforeScoreRun || trend.next_run_id ? (
        <nav aria-label="Cohort result pages" className="flex flex-wrap gap-3 px-4 py-3 sm:px-5">
          {query.beforeScoreRun ? (
            <Link
              className="ui-button"
              href={withFields(path, page, "scorer-cohort-results")}
              prefetch={false}
            >
              First results
            </Link>
          ) : null}
          {trend.next_run_id && trend.next_run_finished_at ? (
            <Link
              className="ui-button"
              href={withFields(
                path,
                {
                  ...page,
                  beforeRunFinishedAt: trend.next_run_finished_at,
                  beforeScoreRun: trend.next_run_id,
                },
                "scorer-cohort-results",
              )}
              prefetch={false}
            >
              Older results
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

function OptionPages({ label, latest, older }: { label: string; latest?: string; older?: string }) {
  if (!latest && !older) return null;
  return (
    <nav
      aria-label={`Browse ${label}`}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
    >
      {latest ? (
        <Link className={linkClass} href={latest} prefetch={false}>
          Latest {label}
        </Link>
      ) : null}
      {older ? (
        <Link className={linkClass} href={older} prefetch={false}>
          Older {label}
        </Link>
      ) : null}
    </nav>
  );
}

export function ScorerTrends({
  workspaceSlug,
  query,
  data,
  path,
  preserved,
  selectRevision,
}: {
  workspaceSlug: string;
  query: ScorerTrendQuery | null;
  data: ScoreTrendPanelData | null;
  path: string;
  preserved: Fields;
  selectRevision?: boolean;
}) {
  const unavailable = !query || !data;
  const trend = data?.trend;
  const revision = data?.revisionId;
  const revisions = data?.revisions ?? [];
  const cohorts = data?.cohorts ?? [];
  const fields = query ? { ...preserved, from: query.from, to: query.to } : preserved;
  const revisionField = selectRevision ? { scorerRevision: revision } : {};
  const revisionPage = {
    beforeRevisionAt: query?.beforeRevisionAt,
    beforeRevisionPolicy: query?.beforeRevisionPolicy,
  };
  const cohortPage = {
    beforeCohortAt: query?.beforeCohortAt,
    beforeCohortPolicy: query?.beforeCohortPolicy,
  };
  const frozenFields = {
    ...fields,
    ...revisionField,
    ...revisionPage,
    ...cohortPage,
    cohort: data?.policyId,
    scoreSnapshot: trend?.snapshot,
  };
  const optionHref = (page: Fields) =>
    withFields(
      path,
      {
        ...frozenFields,
        evaluationDay: query?.evaluationDay,
        evaluationStatus: query?.evaluationStatus,
        beforeRunFinishedAt: trend ? query?.beforeRunFinishedAt : undefined,
        beforeScoreRun: trend ? query?.beforeScoreRun : undefined,
        ...page,
      },
      "scorer-trends",
    );
  const dayHref = (day: string) =>
    withFields(path, { ...frozenFields, evaluationDay: day }, "scorer-cohort-results");
  const showRevisionOptions =
    selectRevision && (revisions.length > 0 || Boolean(query?.beforeRevisionPolicy));
  const showCohortOptions = cohorts.length > 0 || Boolean(query?.beforeCohortPolicy);
  return (
    <PageSection anchorId="scorer-trends" className="min-w-0" title="Scorer trends">
      <div className="min-w-0 space-y-4">
        {unavailable ? (
          <p className="ui-sheet type-secondary px-4 py-4 text-muted sm:px-5">
            {query ? "Scorer trends are unavailable." : "The scorer filters are invalid."}{" "}
            <Link
              className={linkClass}
              href={withFields(path, preserved, "scorer-trends")}
              prefetch={false}
            >
              Reset scorer filters
            </Link>
          </p>
        ) : null}
        {query && data && (showRevisionOptions || showCohortOptions) ? (
          <div className="ui-sheet divide-y divide-border">
            {showRevisionOptions ? (
              <div className="space-y-3 px-4 py-4 sm:px-5">
                {revisions.length ? (
                  <form
                    action={`${path}#scorer-trends`}
                    className="flex flex-wrap items-end gap-3"
                    method="get"
                  >
                    <HiddenFields values={fields} />
                    <label className="type-label flex min-w-0 max-w-full flex-col gap-1.5">
                      Scorer revision
                      <select
                        className="ui-input min-w-0 max-w-full"
                        defaultValue={revision ?? ""}
                        name="scorerRevision"
                        required
                      >
                        {revisions.some(
                          ({ scorer_revision_id }) => scorer_revision_id === revision,
                        ) ? null : (
                          <option value="" disabled>
                            Choose a revision
                          </option>
                        )}
                        {revisions.map((cohort) => (
                          <option key={cohort.scorer_revision_id} value={cohort.scorer_revision_id}>
                            {cohort.scorer_name} · Revision {cohort.scorer_revision_number}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="ui-button" type="submit">
                      Show revision
                    </button>
                  </form>
                ) : null}
                <OptionPages
                  label="scorer revisions"
                  latest={
                    query.beforeRevisionPolicy
                      ? optionHref({ beforeRevisionAt: undefined, beforeRevisionPolicy: undefined })
                      : undefined
                  }
                  older={
                    data.nextRevision
                      ? optionHref({
                          beforeRevisionAt: data.nextRevision.createdAt,
                          beforeRevisionPolicy: data.nextRevision.policyId,
                        })
                      : undefined
                  }
                />
              </div>
            ) : null}
            {showCohortOptions ? (
              <div className="space-y-3 px-4 py-4 sm:px-5">
                {cohorts.length ? (
                  <form
                    action={`${path}#scorer-trends`}
                    className="flex flex-wrap items-end gap-3"
                    method="get"
                  >
                    <HiddenFields
                      values={{ ...preserved, ...revisionField, ...revisionPage, ...cohortPage }}
                    />
                    <label className="type-label flex min-w-0 max-w-full flex-col gap-1.5">
                      Sampling cohort
                      <select
                        className="ui-input min-w-0 max-w-full"
                        defaultValue={data.policyId ?? ""}
                        name="cohort"
                      >
                        {cohorts.map((cohort) => (
                          <option key={cohort.policy_id} value={cohort.policy_id}>
                            {cohortLabel(cohort)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="type-label flex flex-col gap-1.5">
                      From (UTC)
                      <input
                        className="ui-input"
                        defaultValue={query.from}
                        name="from"
                        required
                        type="date"
                      />
                    </label>
                    <label className="type-label flex flex-col gap-1.5">
                      To (exclusive)
                      <input
                        className="ui-input"
                        defaultValue={query.to}
                        name="to"
                        required
                        type="date"
                      />
                    </label>
                    <button className="ui-button-primary h-9 px-3 text-sm" type="submit">
                      Apply scorer filters
                    </button>
                  </form>
                ) : null}
                <OptionPages
                  label="sampling cohorts"
                  latest={
                    query.beforeCohortPolicy
                      ? optionHref({ beforeCohortAt: undefined, beforeCohortPolicy: undefined })
                      : undefined
                  }
                  older={
                    data.nextCohort
                      ? optionHref({
                          beforeCohortAt: data.nextCohort.createdAt,
                          beforeCohortPolicy: data.nextCohort.policyId,
                        })
                      : undefined
                  }
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {trend && query ? (
          <>
            <p className="type-secondary text-muted">
              {trend.cohort.scorer_name} · Revision {trend.cohort.scorer_revision_number} ·{" "}
              {cohortLabel(trend.cohort)}
            </p>
            <TrendCoverage totals={trend.totals} />
            <TrendsFigure dayHref={dayHref} trend={trend} />
            <CohortRows
              fields={frozenFields}
              path={path}
              query={query}
              trend={trend}
              workspaceSlug={workspaceSlug}
            />
          </>
        ) : query && data ? (
          <p className="ui-sheet type-secondary px-4 py-4 text-muted sm:px-5">
            {data.limitExceeded
              ? "This cohort is too large for the selected dates. Choose a shorter date range."
              : data.policyId
                ? "The selected cohort or snapshot is unavailable."
                : "No sampling cohorts are available for this revision."}
          </p>
        ) : null}
      </div>
    </PageSection>
  );
}
