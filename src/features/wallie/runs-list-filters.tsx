"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import type { RunCatalogQuery } from "@/features/wallie/run-catalog-contracts";
import { RUN_PROVIDER_LABELS, runsListFilterHref } from "@/features/wallie/runs-list-state";
import { workspaceRunsPath } from "@/lib/routes";

type Option = { id: string; label: string };

export function RunsListFilters({
  workspaceSlug,
  query,
  sessions,
  stages,
}: {
  workspaceSlug: string;
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
        );
        startTransition(() => router.push(href));
      }}
    >
      {query.limit ? <input name="limit" type="hidden" value={query.limit} /> : null}
      <fieldset className="flex min-w-0 flex-wrap items-end gap-2" disabled={pending}>
        <legend className="sr-only">Run filters</legend>
        <FilterSelect label="Status" name="status" value={query.status}>
          <option value="">All statuses</option>
          <option value="queued">Queued</option>
          <option value="started">Starting</option>
          <option value="running">Running</option>
          <option value="success">Complete</option>
          <option value="error">Failed or interrupted</option>
          <option value="canceled">Canceled</option>
        </FilterSelect>
        <FilterSelect label="Agent" name="provider" value={query.provider}>
          <option value="">All agents</option>
          {Object.entries(RUN_PROVIDER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Session" name="sessionId" value={query.sessionId}>
          <option value="">Any session</option>
          {query.sessionId && !sessions.some((option) => option.id === query.sessionId) ? (
            <option value={query.sessionId}>Selected session</option>
          ) : null}
          <optgroup label="Sessions on this page">
            {sessions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        </FilterSelect>
        <FilterSelect label="Stage" name="stageId" value={query.stageId}>
          <option value="">Any stage</option>
          {query.stageId && !stages.some((option) => option.id === query.stageId) ? (
            <option value={query.stageId}>Selected stage</option>
          ) : null}
          <optgroup label="Stages on this page">
            {stages.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        </FilterSelect>
        <button className={`ui-button-primary ${FILTER_CONTROL_CLASS}`} type="submit">
          <ActionButtonLabel idle="Apply" pending={pending} pendingLabel="Applying…" />
        </button>
        <Link
          className={`ui-button ${FILTER_CONTROL_CLASS}`}
          href={workspaceRunsPath(workspaceSlug)}
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
  label,
  name,
  value,
  children,
}: {
  label: string;
  name: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-1 basis-[140px] flex-col gap-1 text-xs text-muted">
      <span>{label}</span>
      <select
        className={`ui-input max-w-full ${FILTER_CONTROL_CLASS}`}
        defaultValue={value ?? ""}
        name={name}
      >
        {children}
      </select>
    </label>
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
