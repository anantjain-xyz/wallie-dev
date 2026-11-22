import Link from "next/link";
import type { ReactNode } from "react";

import type {
  AnalyticsEvidenceSelection,
  AnalyticsQuery,
  AnalyticsWindow,
} from "@/features/factory-analytics/analytics-query";
import { workspaceAnalyticsPath } from "@/lib/routes";

export const dimensionLabels = {
  source: "Request source",
  person: "Requesting person",
  agent: "Producing agent",
  model: "Model",
  harness: "Harness",
  definition: "Factory definition",
} satisfies Record<AnalyticsQuery["dimension"], string>;

export const evidenceTitles = {
  flow: "Work flow",
  merge: "Request to merge",
  deployment: "Request to deployment",
  "delivery-cost": "Delivery cost",
  "operating-cost": "Operating cost",
  "cost-merges": "Cost denominator",
  throughput: "Pull request throughput",
  revert: "Revert rate",
} satisfies Record<AnalyticsEvidenceSelection["metric"], string>;

export const periodLabels = { primary: "Current period", compare: "Previous period" };
type WithoutPage<Selection extends AnalyticsEvidenceSelection> =
  Selection extends AnalyticsEvidenceSelection ? Omit<Selection, "cursor" | "period"> : never;
export type EvidenceLink = WithoutPage<AnalyticsEvidenceSelection>;
export type AnalyticsHref = (
  evidence?: EvidenceLink & {
    period: AnalyticsEvidenceSelection["period"];
    cursor?: string;
  },
) => string;

export function analyticsCohortHref(
  workspaceSlug: string,
  factoryId: string,
  query: AnalyticsQuery,
  evidence?: Parameters<AnalyticsHref>[0],
) {
  const url = workspaceAnalyticsPath(workspaceSlug, {
    factory: factoryId,
    from: query.from.slice(0, 10),
    to: query.to.slice(0, 10),
    compare: query.comparison ? "previous" : undefined,
    dimension: query.dimension,
    environment: query.environment ?? undefined,
    routingCanary: query.routingCanaryId,
    routingAlert: query.routingAlertId,
    ...evidence,
  });
  return evidence ? `${url}#analytics-evidence` : url;
}

const day = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const timestamp = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});
export const numberFormat = new Intl.NumberFormat("en-US");
export const moneyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});
const durationPart = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function windowLabel({ from, to }: AnalyticsWindow) {
  return `${day.format(new Date(from))} to ${day.format(new Date(to))} UTC`;
}

export function timeLabel(value: string | null | undefined) {
  return value ? `${timestamp.format(new Date(value))} UTC` : "Unknown";
}

export function durationLabel(seconds: number) {
  if (seconds < 60) return `${durationPart.format(seconds)} s`;
  if (seconds < 3_600) return `${durationPart.format(seconds / 60)} min`;
  if (seconds < 86_400) return `${durationPart.format(seconds / 3_600)} h`;
  return `${durationPart.format(seconds / 86_400)} d`;
}

export type MetricPoint = {
  value: number | null;
  label: string;
  evidence: EvidenceLink;
  also?: { label: string; evidence: EvidenceLink };
};
export type MetricRow = {
  key: string;
  label: string;
  actionLabel?: string;
  primary: MetricPoint;
  comparison?: MetricPoint;
};
export type MetricGroup = {
  label: string;
  rows: MetricRow[];
};

const pointClass =
  "rounded-sm text-foreground decoration-border-strong underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function MetricPanel({
  id,
  title,
  definition,
  metadata,
  groups,
  href,
  compare,
}: {
  id: string;
  title: string;
  definition: string;
  metadata: ReactNode;
  groups: MetricGroup[];
  href: AnalyticsHref;
  compare: boolean;
}) {
  const headingId = `${id}-title`;
  return (
    <section aria-labelledby={headingId} className="ui-sheet min-w-0">
      <header className="space-y-2 border-b border-border px-4 py-4 sm:px-6">
        <h2 className="type-section-title" id={headingId}>
          {title}
        </h2>
        <p className="type-secondary max-w-3xl text-muted">{definition}</p>
        {metadata}
      </header>
      <figure aria-label={`${title} chart`} className="space-y-5 px-4 py-5 sm:px-6">
        {compare ? (
          <figcaption className="type-label flex flex-wrap items-center gap-x-5 gap-y-1 text-muted">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="size-2 rounded-sm bg-accent" />
              Current period
            </span>
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="size-2 rounded-sm bg-muted" />
              Previous period
            </span>
          </figcaption>
        ) : null}
        {groups.map((group) => {
          const largest = Math.max(
            1e-9,
            ...group.rows.flatMap(({ primary, comparison }) => [
              primary.value ?? 0,
              comparison?.value ?? 0,
            ]),
          );
          return (
            <div key={group.label}>
              <h3 className="type-label mb-2 text-muted">{group.label}</h3>
              <ul className="space-y-2">
                {group.rows.map((row) => (
                  <li
                    key={row.key}
                    className="grid gap-1 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,4fr)] sm:items-center sm:gap-3"
                  >
                    <span className="type-secondary break-words">{row.label}</span>
                    <div className="grid min-w-0 gap-1">
                      <ChartPoint
                        href={href}
                        largest={largest}
                        point={row.primary}
                        period="primary"
                        row={row.actionLabel ?? row.label}
                      />
                      {row.comparison && (
                        <ChartPoint
                          href={href}
                          largest={largest}
                          point={row.comparison}
                          period="compare"
                          row={row.actionLabel ?? row.label}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </figure>
      <div className="overflow-x-auto border-t border-border">
        <table className="type-secondary w-full text-left">
          <caption className="sr-only">{title} comparison table</caption>
          <thead className="text-muted">
            <tr>
              <th className="px-4 py-3 font-medium sm:px-6" scope="col">
                Metric
              </th>
              <th className="px-4 py-3 font-medium sm:px-6" scope="col">
                Current period
              </th>
              {compare && (
                <th className="px-4 py-3 font-medium sm:px-6" scope="col">
                  Previous period
                </th>
              )}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.label}>
              <tr className="border-t border-border">
                <th
                  className="type-label px-4 py-2 text-muted sm:px-6"
                  colSpan={compare ? 3 : 2}
                  scope="rowgroup"
                >
                  {group.label}
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr className="border-t border-border" key={row.key}>
                  <th className="break-words px-4 py-2 font-medium sm:px-6" scope="row">
                    {row.label}
                  </th>
                  <TablePoint
                    href={href}
                    point={row.primary}
                    period="primary"
                    row={row.actionLabel ?? row.label}
                  />
                  {row.comparison && (
                    <TablePoint
                      href={href}
                      point={row.comparison}
                      period="compare"
                      row={row.actionLabel ?? row.label}
                    />
                  )}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function ChartPoint({
  point,
  row,
  period,
  href,
  largest,
}: {
  point: MetricPoint;
  row: string;
  period: keyof typeof periodLabels;
  href: AnalyticsHref;
  largest: number;
}) {
  return (
    <Link
      aria-label={`${row}, ${periodLabels[period]}, evidence, ${point.label}`}
      className={`grid min-w-0 grid-cols-[minmax(2rem,1fr)_minmax(6rem,auto)] items-center gap-3 py-0.5 ${pointClass}`}
      href={href({ ...point.evidence, period })}
      prefetch={false}
    >
      <span aria-hidden className="bg-accent-soft relative h-2 overflow-hidden rounded-sm">
        {point.value !== null && (
          <span
            className={`absolute inset-y-0 start-0 rounded-sm ${period === "primary" ? "bg-accent" : "bg-muted"}`}
            style={{ width: `${(point.value / largest) * 100}%` }}
          />
        )}
      </span>
      <span className="type-secondary min-w-0 tabular-nums">{point.label}</span>
    </Link>
  );
}

function TablePoint({
  point,
  row,
  period,
  href,
}: {
  point: MetricPoint;
  row: string;
  period: keyof typeof periodLabels;
  href: AnalyticsHref;
}) {
  return (
    <td className="px-4 py-2 tabular-nums sm:px-6">
      <Link
        aria-label={`${row}, ${periodLabels[period]}, table evidence, ${point.label}`}
        className={`${pointClass} underline`}
        href={href({ ...point.evidence, period })}
        prefetch={false}
      >
        {point.label}
      </Link>
      {point.also && (
        <Link
          aria-label={`${row}, ${periodLabels[period]}, ${point.also.label}`}
          className={`ml-2 ${pointClass} underline`}
          href={href({ ...point.also.evidence, period })}
          prefetch={false}
        >
          {point.also.label}
        </Link>
      )}
    </td>
  );
}
