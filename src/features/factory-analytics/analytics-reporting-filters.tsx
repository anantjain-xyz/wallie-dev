"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";

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

export function AnalyticsReportingFilters({
  action,
  factoryId,
  query,
  environments,
  scorerFields,
  errors,
  dates,
  mode = "recovery",
}: {
  action: string;
  factoryId: string;
  query: AnalyticsQuery;
  environments?: string[] | null;
  scorerFields: Record<string, string | undefined>;
  errors?: AnalyticsFilterErrors;
  dates?: { from: string; to: string };
  mode?: "period" | "dimension" | "environment" | "recovery";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const core = analyticsCoreFields(factoryId, query);
  const evidence = analyticsEvidenceFields(query.evidence);
  const showPeriod = mode === "period" || mode === "recovery";
  const showDimension = mode === "dimension" || mode === "recovery";
  const showEnvironment = mode === "environment" || mode === "recovery";
  const anchor =
    mode === "dimension" ? "#throughput" : mode === "environment" ? "#time-to-delivery" : "";
  const environment = query.environment ?? "";
  const [instantValue, setInstantValue] = useOptimistic(
    mode === "dimension" ? query.dimension : environment,
  );
  const fieldsHref = (changes: Parameters<typeof applyAnalyticsFields>[0]) =>
    analyticsFieldsHref(action, applyAnalyticsFields(changes, core, evidence, scorerFields)) +
    anchor;
  function applySelection(name: "dimension" | "environment", value: string) {
    if (value === instantValue) return;
    startTransition(() => {
      setInstantValue(value);
      router.push(fieldsHref({ [name]: value || undefined }), { scroll: false });
    });
  }
  const missingEnvironment = Boolean(
    environment && environments && !environments.includes(environment),
  );
  const clearEnvironment =
    analyticsFieldsHref(action, {
      ...applyAnalyticsFields({ environment: undefined }, core, evidence, scorerFields),
      ...dates,
    }) + anchor;
  return (
    <section
      aria-label={
        showPeriod
          ? "Reporting filters"
          : mode === "dimension"
            ? "Throughput breakdown"
            : "Deployment filter"
      }
      className={showPeriod ? "scroll-mt-4" : undefined}
      id={showPeriod ? "analytics-filters" : undefined}
      tabIndex={showPeriod ? -1 : undefined}
    >
      <form
        action={action + anchor}
        aria-busy={pending}
        className={
          mode === "recovery"
            ? "ui-sheet space-y-3 p-4"
            : mode === "period"
              ? "space-y-3 px-4 pb-4 sm:px-5"
              : "space-y-2"
        }
        id={showPeriod ? "overview-filters" : undefined}
        tabIndex={showPeriod ? -1 : undefined}
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const changes = Object.fromEntries(
            ["from", "to", "compare", "dimension", "environment"].map((name) => [
              name,
              form.get(name)?.toString() || undefined,
            ]),
          );
          const href = fieldsHref(changes);
          startTransition(() => router.push(href, { scroll: false }));
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          {Object.entries({
            factory: factoryId,
            routingCanary: query.routingCanaryId,
            routingAlert: query.routingAlertId,
            scorerRevision: scorerFields.scorerRevision,
            cohort: scorerFields.cohort,
            ...(showPeriod ? {} : { from: core.from, to: core.to, compare: core.compare }),
            ...(showDimension ? {} : { dimension: core.dimension }),
            ...(showEnvironment ? {} : { environment: core.environment }),
          }).map(([name, value]) =>
            value ? <input key={name} name={name} type="hidden" value={value} /> : null,
          )}
          {showPeriod && (
            <label className="type-label flex min-w-0 flex-col gap-1.5">
              From date (UTC)
              <input
                aria-describedby={errors?.range ? "analytics-range-error" : undefined}
                aria-invalid={Boolean(errors?.range)}
                autoComplete="off"
                className="ui-input"
                defaultValue={dates?.from ?? core.from}
                key={dates?.from ?? core.from}
                name="from"
                required
                type="date"
              />
            </label>
          )}
          {showPeriod && (
            <label className="type-label flex min-w-0 flex-col gap-1.5">
              To date (UTC, exclusive)
              <input
                aria-describedby={errors?.range ? "analytics-range-error" : undefined}
                aria-invalid={Boolean(errors?.range)}
                autoComplete="off"
                className="ui-input"
                defaultValue={dates?.to ?? core.to}
                key={dates?.to ?? core.to}
                name="to"
                required
                type="date"
              />
            </label>
          )}
          {showDimension && (
            <SelectField
              aria-describedby={errors?.dimension ? "analytics-dimension-error" : undefined}
              aria-invalid={errors?.dimension ? true : undefined}
              className="min-w-44 max-w-full"
              defaultValue={mode === "recovery" ? query.dimension : undefined}
              key={mode === "recovery" ? query.dimension : undefined}
              label="Break down throughput by"
              labelClassName="type-label"
              name="dimension"
              onValueChange={
                mode === "dimension" ? (value) => applySelection("dimension", value) : undefined
              }
              options={Object.entries(dimensionLabels).map(([value, label]) => ({ label, value }))}
              value={mode === "dimension" ? instantValue : undefined}
            />
          )}
          {showEnvironment && (
            <SelectField
              aria-describedby={
                errors?.environment
                  ? "analytics-environment-error"
                  : missingEnvironment
                    ? "analytics-environment-help analytics-environment-missing"
                    : "analytics-environment-help"
              }
              aria-invalid={errors?.environment ? true : undefined}
              className="min-w-44 max-w-full"
              defaultValue={mode === "recovery" ? environment : undefined}
              emptyOption={{ label: "All environments", value: "" }}
              key={mode === "recovery" ? environment : undefined}
              label="Deployment environment"
              labelClassName="type-label"
              name="environment"
              onValueChange={
                mode === "environment" ? (value) => applySelection("environment", value) : undefined
              }
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
              value={mode === "environment" ? instantValue : undefined}
              wrap
            />
          )}
          {showPeriod && (
            <label className="type-label flex min-h-9 items-center gap-2">
              <input
                aria-describedby={errors?.compare ? "analytics-compare-error" : undefined}
                aria-invalid={errors?.compare ? true : undefined}
                defaultChecked={Boolean(query.comparison)}
                key={String(Boolean(query.comparison))}
                name="compare"
                type="checkbox"
                value="previous"
              />
              Compare with previous period
            </label>
          )}
          {showPeriod && (
            <button className="ui-button" disabled={pending} type="submit">
              <ActionButtonLabel
                idle="Apply filters"
                pending={pending}
                pendingLabel="Applying filters…"
              />
            </button>
          )}
          {mode === "period" && (
            <Link
              className="ui-button"
              href={fieldsHref({ from: undefined, to: undefined, compare: undefined })}
              prefetch={false}
              scroll={false}
            >
              Reset dates
            </Link>
          )}
          {mode === "dimension" && query.dimension !== "source" && (
            <Link
              className="ui-button"
              href={fieldsHref({ dimension: "source" })}
              prefetch={false}
              scroll={false}
            >
              Reset breakdown
            </Link>
          )}
        </div>
        {showEnvironment && (
          <p className="type-label text-muted" id="analytics-environment-help">
            Environment applies to deployment timing only.
          </p>
        )}
        {showEnvironment && missingEnvironment && (
          <p className="type-secondary text-muted" id="analytics-environment-missing">
            The saved environment <code className="break-all">{environment}</code> has no recorded
            deployments for this factory.{" "}
            <a className="text-accent underline underline-offset-4" href={clearEnvironment}>
              Clear environment
            </a>
          </p>
        )}
        {mode === "environment" && environment && !missingEnvironment && (
          <a
            className="type-secondary text-accent underline underline-offset-4"
            href={clearEnvironment}
          >
            Clear environment
          </a>
        )}
        {showEnvironment && !environments && (
          <p className="type-secondary text-muted">
            Could not load deployment environments.{" "}
            <button
              className="cursor-pointer rounded-sm text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent"
              disabled={pending}
              onClick={() => startTransition(() => router.refresh())}
              type="button"
            >
              Try again
            </button>
          </p>
        )}
        {errors && (
          <div className="type-secondary space-y-1" role="alert">
            {errors.range && <p id="analytics-range-error">{errors.range}</p>}
            {errors.compare && <p id="analytics-compare-error">{errors.compare}</p>}
            {errors.dimension && <p id="analytics-dimension-error">{errors.dimension}</p>}
            {errors.environment && <p id="analytics-environment-error">{errors.environment}</p>}
            {errors.other && <p>{errors.other}</p>}
            <Link
              className="text-accent underline underline-offset-4"
              href={analyticsFieldsHref(action, { factory: factoryId })}
              prefetch={false}
            >
              Reset reporting filters
            </Link>
          </div>
        )}
        {mode === "period" && query.comparison && (
          <p className="type-secondary text-muted">
            Previous period: {windowLabel(query.comparison)} (end excluded).
          </p>
        )}
      </form>
    </section>
  );
}
