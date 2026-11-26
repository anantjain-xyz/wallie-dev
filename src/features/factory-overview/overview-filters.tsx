import Link from "next/link";
import { z } from "zod";

import {
  type AnalyticsQuery,
  parseAnalyticsQuery,
} from "@/features/factory-analytics/analytics-query";
import { workspaceOverviewPath } from "@/lib/routes";

type FilterErrors = Partial<Record<"from" | "to" | "environment" | "compare" | "options", string>>;
const date = z
  .string()
  .date()
  .refine((value) => !value.startsWith("0000-"));

export function invalidOverviewFilters(
  search: Parameters<typeof parseAnalyticsQuery>[0],
  now: Date,
) {
  const { from, to, environment, compare, dimension, routingCanary, routingAlert } = search;
  const errors: FilterErrors = {};
  const dates = parseAnalyticsQuery({ from, to }, now);
  if (!dates.success) {
    const dateError = "Enter a single date in YYYY-MM-DD format, with year 0001 or later.";
    if (!date.safeParse(from).success) errors.from = dateError;
    if (!date.safeParse(to).success) errors.to = dateError;
    if (!errors.from && !errors.to) {
      errors.to = "Choose an end date 1 to 366 days after the start date.";
    }
  }
  if (compare !== undefined && compare !== "previous") {
    errors.compare = "Choose whether to compare with the previous period.";
  } else if (compare && dates.success && !parseAnalyticsQuery({ from, to, compare }, now).success) {
    errors.compare = "Move the date range later or turn off the previous-period comparison.";
  }
  if (!parseAnalyticsQuery({ environment }, now).success) {
    errors.environment =
      "Enter one environment using lowercase letters or numbers, with periods, underscores or hyphens. Start with a letter or number (64 characters max).";
  }
  const breakdown = parseAnalyticsQuery({ dimension }, now);
  const routing = parseAnalyticsQuery({ routingCanary, routingAlert }, now);
  if (
    !breakdown.success ||
    !routing.success ||
    ["metric", "period", "facet", "bucket", "cursor"].some((key) => search[key] !== undefined)
  ) {
    errors.options =
      "This link has options Overview doesn’t support. Apply filters to remove them.";
  }

  function first(value: string | string[] | undefined) {
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  }

  return {
    from: first(from) || (from === undefined && dates.success ? dates.data.from.slice(0, 10) : ""),
    to: first(to) || (to === undefined && dates.success ? dates.data.to.slice(0, 10) : ""),
    environment: first(environment),
    compare: first(compare) === "previous",
    dimension: breakdown.success ? breakdown.data.dimension : undefined,
    routingCanaryId: routing.success ? routing.data.routingCanaryId : undefined,
    routingAlertId: routing.success ? routing.data.routingAlertId : undefined,
    errors,
  };
}

export function OverviewFilters({
  factoryId,
  workspaceSlug,
  from,
  to,
  environment,
  compare,
  dimension,
  routingCanaryId,
  routingAlertId,
  errors,
}: {
  factoryId: string;
  workspaceSlug: string;
  from: string;
  to: string;
  environment: string | null;
  compare: boolean;
  dimension?: AnalyticsQuery["dimension"];
  routingCanaryId?: string;
  routingAlertId?: string;
  errors?: FilterErrors;
}) {
  const action = workspaceOverviewPath(workspaceSlug);
  return (
    <section className="ui-sheet space-y-3 px-4 py-4 sm:px-5">
      <h2 className="type-section-title scroll-mt-20" id="overview-filters">
        {errors ? "Correct Overview filters" : "Overview filters"}
      </h2>
      {errors?.options && <p className="type-secondary text-danger">{errors.options}</p>}
      <form aria-labelledby="overview-filters" className="space-y-4" action={action} method="get">
        <input name="factory" type="hidden" value={factoryId} />
        {dimension && <input name="dimension" type="hidden" value={dimension} />}
        {routingCanaryId && <input name="routingCanary" type="hidden" value={routingCanaryId} />}
        {routingAlertId && <input name="routingAlert" type="hidden" value={routingAlertId} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <FilterInput label="From date" name="from" value={from} error={errors?.from} />
          <FilterInput label="To date" name="to" value={to} error={errors?.to} />
          <FilterInput
            label="Deployment environment"
            name="environment"
            value={environment ?? ""}
            error={errors?.environment}
          />
        </div>
        <p className="type-secondary text-muted">Dates include the start and exclude the end.</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div>
            <label className="type-label flex min-h-9 items-center gap-2">
              <input
                aria-describedby={errors?.compare ? "overview-compare-error" : undefined}
                aria-invalid={errors?.compare ? true : undefined}
                defaultChecked={compare}
                name="compare"
                type="checkbox"
                value="previous"
              />
              Compare with previous period
            </label>
            {errors?.compare && (
              <p className="type-secondary text-danger" id="overview-compare-error">
                {errors.compare}
              </p>
            )}
          </div>
          <button className="ui-button-primary min-h-9 px-3 text-sm" type="submit">
            Apply filters
          </button>
          {errors && (
            <Link
              className="type-secondary font-medium underline underline-offset-4 hover:text-accent"
              href={workspaceOverviewPath(workspaceSlug, { factory: factoryId })}
              prefetch={false}
            >
              Reset Overview filters
            </Link>
          )}
        </div>
      </form>
    </section>
  );
}

function FilterInput({
  label,
  name,
  value,
  error,
}: {
  label: string;
  name: "from" | "to" | "environment";
  value: string;
  error?: string;
}) {
  const id = `overview-${name}`;
  const isDate = name !== "environment";
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="type-label block" htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        className="ui-input w-full min-w-0"
        defaultValue={value}
        id={id}
        maxLength={isDate ? undefined : 64}
        name={name}
        placeholder={isDate ? undefined : "All environments"}
        required={isDate}
        spellCheck={false}
        type={isDate && (!value || date.safeParse(value).success) ? "date" : "text"}
      />
      {error && (
        <p className="type-secondary text-danger" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
