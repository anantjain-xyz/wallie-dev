import Link from "next/link";
import type { ReactNode } from "react";

import type {
  AnalyticsEvidenceSelection,
  AnalyticsQuery,
  AnalyticsWindow,
} from "@/features/factory-analytics/analytics-query";
import { workspaceAnalyticsPath } from "@/lib/routes";
import { analyticsCoreFields } from "./analytics-navigation";

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
export const metricPanelIds = {
  flow: "work-flow",
  merge: "time-to-delivery",
  deployment: "time-to-delivery",
  "delivery-cost": "cost-per-merge",
  "operating-cost": "cost-per-merge",
  "cost-merges": "cost-per-merge",
  throughput: "throughput",
  revert: "revert-rate",
} satisfies Record<AnalyticsEvidenceSelection["metric"], string>;

export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer font-medium">Technical details</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
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
  scorerFields?: Record<string, string | undefined>,
) {
  const url = workspaceAnalyticsPath(workspaceSlug, {
    ...analyticsCoreFields(factoryId, query),
    ...scorerFields,
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
  scale?: "percent";
};

const pointClass =
  "rounded-sm text-foreground decoration-border-strong underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function MetricPanel({
  id,
  title,
  definition,
  filters,
  metadata,
  summary,
  groups,
  href,
  compare,
}: {
  id: string;
  title: string;
  definition: string;
  filters?: ReactNode;
  metadata: ReactNode;
  summary: ReactNode;
  groups: MetricGroup[];
  href: AnalyticsHref;
  compare: boolean;
}) {
  const headingId = `${id}-title`;
  return (
    <section
      aria-labelledby={headingId}
      className="ui-sheet min-w-0 scroll-mt-4"
      id={id}
      tabIndex={-1}
    >
      <header className="space-y-2 border-b border-border px-4 py-4 sm:px-6">
        <h2 className="type-section-title scroll-mt-4" id={headingId}>
          {title}
        </h2>
        <details className="type-secondary max-w-3xl text-muted">
          <summary className="w-fit cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Metric definition
          </summary>
          <p className="mt-1">{definition}</p>
        </details>
        {filters}
        {summary}
        {metadata}
      </header>
      <div className="overflow-x-auto">
        <table className="type-secondary w-full table-fixed text-left">
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
          {groups.map((group) => {
            const scale =
              group.scale === "percent"
                ? 1
                : Math.max(
                    0,
                    ...group.rows.flatMap(({ primary, comparison }) => [
                      primary.value ?? 0,
                      comparison?.value ?? 0,
                    ]),
                  );
            return (
              <tbody key={group.label}>
                <tr className="border-t border-border">
                  <th
                    className="type-label px-4 py-2 text-muted sm:px-6"
                    colSpan={compare ? 3 : 2}
                    scope="rowgroup"
                  >
                    {group.label} ·{" "}
                    {group.scale === "percent"
                      ? "0–100% scale"
                      : "Bars relative to the largest value in this group"}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr className="border-t border-border" key={row.key}>
                    <th className="break-words px-2 py-2 font-medium sm:px-6" scope="row">
                      {row.label}
                    </th>
                    <TablePoint
                      href={href}
                      point={row.primary}
                      scale={scale}
                      period="primary"
                      row={row.actionLabel ?? row.label}
                    />
                    {row.comparison && (
                      <TablePoint
                        href={href}
                        point={row.comparison}
                        scale={scale}
                        period="compare"
                        row={row.actionLabel ?? row.label}
                      />
                    )}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </section>
  );
}

function TablePoint({
  point,
  row,
  period,
  href,
  scale,
}: {
  point: MetricPoint;
  row: string;
  period: keyof typeof periodLabels;
  href: AnalyticsHref;
  scale: number;
}) {
  return (
    <td className="break-words px-2 py-2 tabular-nums sm:px-6">
      <Link
        aria-label={`${row}, ${periodLabels[period]}, evidence, ${point.label}`}
        className={`inline-block py-1 ${pointClass} underline`}
        href={href({ ...point.evidence, period })}
        prefetch={false}
      >
        {point.label}
      </Link>
      {point.value !== null && (
        <div
          aria-hidden="true"
          className="bg-accent-soft mb-1 h-1.5 max-w-28 overflow-hidden rounded-sm"
        >
          <span
            className={`block h-full ${period === "primary" ? "bg-accent" : "bg-muted"}`}
            style={{ width: `${scale > 0 ? (point.value / scale) * 100 : 0}%` }}
          />
        </div>
      )}
      {point.also && (
        <Link
          aria-label={`${row}, ${periodLabels[period]}, ${point.also.label}`}
          className={`block w-fit py-1 text-xs ${pointClass} underline`}
          href={href({ ...point.also.evidence, period })}
          prefetch={false}
        >
          {point.also.label}
        </Link>
      )}
    </td>
  );
}
