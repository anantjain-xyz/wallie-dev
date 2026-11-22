import { SelectField } from "@/components/ui/select";
import type { AnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import { dimensionLabels, windowLabel } from "@/features/factory-analytics/analytics-view-shared";

export function AnalyticsFilters({
  action,
  factoryId,
  query,
}: {
  action: string;
  factoryId: string;
  query: AnalyticsQuery;
}) {
  return (
    <>
      <form
        action={action}
        className="ui-sheet mb-6 flex flex-wrap items-end gap-4 p-4"
        method="get"
      >
        <input name="factory" type="hidden" value={factoryId} />
        {query.routingCanaryId ? (
          <input name="routingCanary" type="hidden" value={query.routingCanaryId} />
        ) : null}
        {query.routingAlertId ? (
          <input name="routingAlert" type="hidden" value={query.routingAlertId} />
        ) : null}
        <label className="type-label flex flex-col gap-1.5">
          From date
          <input
            className="ui-input"
            defaultValue={query.from.slice(0, 10)}
            name="from"
            required
            type="date"
          />
        </label>
        <label className="type-label flex flex-col gap-1.5">
          To date
          <input
            className="ui-input"
            defaultValue={query.to.slice(0, 10)}
            name="to"
            required
            type="date"
          />
        </label>
        <SelectField
          className="min-w-44"
          defaultValue={query.dimension}
          label="Break down throughput by"
          labelClassName="type-label"
          name="dimension"
          options={Object.entries(dimensionLabels).map(([value, label]) => ({ label, value }))}
        />
        <label className="type-label flex flex-col gap-1.5">
          Deployment environment
          <input
            className="ui-input"
            defaultValue={query.environment ?? ""}
            maxLength={64}
            name="environment"
            placeholder="All environments"
          />
        </label>
        <label className="type-label flex h-9 items-center gap-2">
          <input
            defaultChecked={query.comparison !== null}
            name="compare"
            type="checkbox"
            value="previous"
          />
          Compare with previous period
        </label>
        <button className="ui-button-primary h-9 px-3 text-sm" type="submit">
          Apply filters
        </button>
      </form>
      <p className="type-secondary mb-8 text-muted">
        {windowLabel(query)}. Dates include the start and exclude the end.
        {query.comparison ? ` Previous period ${windowLabel(query.comparison)}.` : ""}
      </p>
    </>
  );
}
