"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField } from "@/components/ui/select";

import {
  analyticsCoreFields,
  analyticsEvidenceFields,
  analyticsFieldsHref,
  applyAnalyticsFields,
} from "./analytics-navigation";
import type { AnalyticsFilterErrors, AnalyticsQuery } from "./analytics-query";
import { dimensionLabels, windowLabel } from "./analytics-view-shared";

export function AnalyticsFilters({
  action,
  factoryId,
  query,
  environments,
  scorerFields,
  errors,
  dates,
}: {
  action: string;
  factoryId: string;
  query: AnalyticsQuery;
  environments: string[] | null;
  scorerFields: Record<string, string | undefined>;
  errors?: AnalyticsFilterErrors;
  dates?: { from: string; to: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const core = analyticsCoreFields(factoryId, query);
  const evidence = analyticsEvidenceFields(query.evidence);
  const environment = query.environment ?? "";
  const missingEnvironment = Boolean(
    environment && environments && !environments.includes(environment),
  );
  const clearEnvironment = analyticsFieldsHref(action, {
    ...core,
    ...evidence,
    cursor: undefined,
    ...scorerFields,
    environment: undefined,
  });
  return (
    <section
      aria-label="Reporting filters"
      className="mb-6 space-y-3 scroll-mt-4"
      id="analytics-filters"
      tabIndex={-1}
    >
      <form
        action={action}
        aria-busy={pending}
        className="ui-sheet space-y-3 p-4"
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = applyAnalyticsFields(
            new FormData(event.currentTarget),
            core,
            evidence,
            scorerFields,
          );
          startTransition(() => router.push(analyticsFieldsHref(action, fields)));
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          {Object.entries({
            factory: factoryId,
            routingCanary: query.routingCanaryId,
            routingAlert: query.routingAlertId,
            scorerRevision: scorerFields.scorerRevision,
            cohort: scorerFields.cohort,
          }).map(([name, value]) =>
            value ? <input key={name} name={name} type="hidden" value={value} /> : null,
          )}
          <label className="type-label flex flex-col gap-1.5">
            From date (UTC)
            <input
              aria-describedby={errors?.range ? "analytics-range-error" : undefined}
              aria-invalid={Boolean(errors?.range)}
              className="ui-input"
              defaultValue={dates?.from ?? core.from}
              key={dates?.from ?? core.from}
              name="from"
              required
              type="date"
            />
          </label>
          <label className="type-label flex flex-col gap-1.5">
            To date (UTC, exclusive)
            <input
              aria-describedby={errors?.range ? "analytics-range-error" : undefined}
              aria-invalid={Boolean(errors?.range)}
              className="ui-input"
              defaultValue={dates?.to ?? core.to}
              key={dates?.to ?? core.to}
              name="to"
              required
              type="date"
            />
          </label>
          <SelectField
            aria-describedby={errors?.dimension ? "analytics-dimension-error" : undefined}
            className="min-w-44 max-w-full"
            defaultValue={query.dimension}
            key={query.dimension}
            label="Break down throughput by"
            labelClassName="type-label"
            name="dimension"
            options={Object.entries(dimensionLabels).map(([value, label]) => ({ label, value }))}
          />
          <SelectField
            aria-describedby={
              errors?.environment
                ? "analytics-environment-error"
                : missingEnvironment
                  ? "analytics-environment-help analytics-environment-missing"
                  : "analytics-environment-help"
            }
            className="min-w-44 max-w-full"
            defaultValue={environment}
            emptyOption={{ label: "All environments", value: "" }}
            key={environment}
            label="Deployment environment"
            labelClassName="type-label"
            name="environment"
            options={[
              ...(environment && (missingEnvironment || !environments)
                ? [
                    {
                      label: missingEnvironment ? "Saved environment (not listed)" : environment,
                      value: environment,
                    },
                  ]
                : []),
              ...(environments ?? []).map((value) => ({ label: value, value })),
            ]}
            wrap
          />
          <label className="type-label flex min-h-9 items-center gap-2">
            <input
              defaultChecked={Boolean(query.comparison)}
              key={String(Boolean(query.comparison))}
              name="compare"
              type="checkbox"
              value="previous"
            />
            Compare with previous period
          </label>
          <button className="ui-button-primary" disabled={pending} type="submit">
            <ActionButtonLabel
              idle="Apply filters"
              pending={pending}
              pendingLabel="Applying filters…"
            />
          </button>
        </div>
        <p className="type-label text-muted" id="analytics-environment-help">
          Environment applies to deployment timing only.
        </p>
        {missingEnvironment && (
          <p className="type-secondary text-muted" id="analytics-environment-missing">
            The saved environment <code className="break-all">{environment}</code> has no recorded
            deployments for this factory.{" "}
            <a className="text-accent underline underline-offset-4" href={clearEnvironment}>
              Clear environment
            </a>
          </p>
        )}
        {!environments && (
          <p className="type-secondary text-muted">
            Could not load deployment environments. Apply filters to try again.
          </p>
        )}
        {errors && (
          <div className="type-secondary space-y-1" role="alert">
            {errors.range && <p id="analytics-range-error">{errors.range}</p>}
            {errors.compare && <p>{errors.compare}</p>}
            {errors.dimension && <p id="analytics-dimension-error">{errors.dimension}</p>}
            {errors.environment && <p id="analytics-environment-error">{errors.environment}</p>}
            {errors.other && <p>{errors.other}</p>}
          </div>
        )}
      </form>
      {!errors && (
        <p className="type-secondary text-muted">
          {windowLabel(query)} (end excluded).
          {query.comparison ? ` Previous period ${windowLabel(query.comparison)}.` : ""}
        </p>
      )}
    </section>
  );
}
