"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField, type SelectOption, type SelectOptionGroup } from "@/components/ui/select";
import { FACTORY_QUERY_PARAM, withFactoryQuery } from "@/features/factories/factory-selection";
import type { RunCatalogQuery } from "@/features/wallie/run-catalog-contracts";
import { RUN_PROVIDER_LABELS, runsListFilterHref } from "@/features/wallie/runs-list-state";
import { workspaceRunsPath } from "@/lib/routes";

type Option = { id: string; label: string };

export function RunsListFilters({
  workspaceSlug,
  factoryQuery,
  query,
  sessions,
  stages,
}: {
  workspaceSlug: string;
  factoryQuery?: string;
  query: RunCatalogQuery;
  sessions: Option[];
  stages: Option[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={workspaceRunsPath(workspaceSlug)}
      aria-label="Filter runs"
      className="mb-5 border-y border-border py-3"
      onSubmit={(event) => {
        event.preventDefault();
        const href = runsListFilterHref(
          workspaceSlug,
          new FormData(event.currentTarget),
          query.limit,
          factoryQuery,
        );
        startTransition(() => router.push(href));
      }}
    >
      {query.limit ? <input name="limit" type="hidden" value={query.limit} /> : null}
      {factoryQuery ? (
        <input name={FACTORY_QUERY_PARAM} type="hidden" value={factoryQuery} />
      ) : null}
      <fieldset className="flex min-w-0 flex-wrap items-end gap-2" disabled={pending}>
        <legend className="sr-only">Run filters</legend>
        <FilterSelect
          label="Status"
          name="status"
          options={[
            { label: "All statuses", value: "" },
            { label: "Queued", value: "queued" },
            { label: "Starting", value: "started" },
            { label: "Running", value: "running" },
            { label: "Complete", value: "success" },
            { label: "Failed or interrupted", value: "error" },
            { label: "Canceled", value: "canceled" },
          ]}
          value={query.status}
        />
        <FilterSelect
          label="Agent"
          name="provider"
          options={[
            { label: "All agents", value: "" },
            ...Object.entries(RUN_PROVIDER_LABELS).map(([value, label]) => ({ label, value })),
          ]}
          value={query.provider}
        />
        <FilterSelect
          groups={[
            {
              label: "Sessions on this page",
              options: sessions.map((option) => ({ label: option.label, value: option.id })),
            },
          ]}
          label="Session"
          name="sessionId"
          options={[
            { label: "Any session", value: "" },
            ...(query.sessionId && !sessions.some((option) => option.id === query.sessionId)
              ? [{ label: "Selected session", value: query.sessionId }]
              : []),
          ]}
          value={query.sessionId}
          wrap
        />
        <FilterSelect
          groups={[
            {
              label: "Stages on this page",
              options: stages.map((option) => ({ label: option.label, value: option.id })),
            },
          ]}
          label="Stage"
          name="stageId"
          options={[
            { label: "Any stage", value: "" },
            ...(query.stageId && !stages.some((option) => option.id === query.stageId)
              ? [{ label: "Selected stage", value: query.stageId }]
              : []),
          ]}
          value={query.stageId}
          wrap
        />
        <button className={`ui-button-primary ${FILTER_CONTROL_CLASS}`} type="submit">
          <ActionButtonLabel idle="Apply" pending={pending} pendingLabel="Applying…" />
        </button>
        <Link
          className={`ui-button ${FILTER_CONTROL_CLASS}`}
          href={withFactoryQuery(workspaceRunsPath(workspaceSlug), factoryQuery)}
        >
          Clear
        </Link>
      </fieldset>
      <p className="mt-2 text-xs text-muted">Session and stage choices come from this page.</p>
      <span className="sr-only" role="status">
        {pending ? "Loading filtered runs…" : ""}
      </span>
    </form>
  );
}

function FilterSelect({
  groups,
  label,
  name,
  options,
  value,
  wrap,
}: {
  groups?: readonly SelectOptionGroup[];
  label: string;
  name: string;
  options: readonly SelectOption[];
  value?: string;
  wrap?: boolean;
}) {
  return (
    <SelectField
      className="flex-1 basis-[140px] space-y-1"
      defaultValue={value ?? ""}
      groups={groups}
      label={label}
      labelClassName="text-xs font-normal text-muted"
      name={name}
      options={options}
      triggerClassName={`max-w-full py-1.5 ${FILTER_CONTROL_CLASS}`}
      wrap={wrap}
    />
  );
}

export function RunsListRefresh({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      className="ui-button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      type="button"
    >
      <ActionButtonLabel idle={label} pending={pending} pendingLabel="Refreshing…" />
    </button>
  );
}
