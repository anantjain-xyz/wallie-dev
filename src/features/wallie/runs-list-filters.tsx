"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField, type SelectOption } from "@/components/ui/select";
import { FACTORY_QUERY_PARAM, withFactoryQuery } from "@/features/factories/factory-selection";
import type { RunCatalogQuery } from "@/features/wallie/run-catalog-contracts";
import { RunSessionFilter } from "@/features/wallie/run-session-filter";
import type { RunSessionOption, RunStageOption } from "@/features/wallie/runs-list-options";
import {
  RUN_PROVIDER_LABELS,
  runsListFilterHref,
  runsListPageHref,
} from "@/features/wallie/runs-list-state";
import { workspaceRunsPath } from "@/lib/routes";

export function RunsListFilters({
  workspaceId,
  workspaceSlug,
  factoryQuery,
  query,
  sessionOption,
  stages,
  promptFilterLabel,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factoryQuery?: string;
  query: RunCatalogQuery;
  sessionOption?: RunSessionOption | null;
  stages?: RunStageOption[] | null;
  promptFilterLabel?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const stageUnavailable = query.stageId && !stages?.some((option) => option.id === query.stageId);
  const { agentId, agentPromptRevisionId } = query;

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
          { agentId, agentPromptRevisionId },
        );
        startTransition(() => router.push(href));
      }}
    >
      {query.limit ? <input name="limit" type="hidden" value={query.limit} /> : null}
      {factoryQuery ? (
        <input name={FACTORY_QUERY_PARAM} type="hidden" value={factoryQuery} />
      ) : null}
      {agentId && agentPromptRevisionId ? (
        <>
          <input name="agentId" type="hidden" value={agentId} />
          <input name="agentPromptRevisionId" type="hidden" value={agentPromptRevisionId} />
        </>
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
        <RunSessionFilter
          factory={factoryQuery ?? "all"}
          selectedId={query.sessionId}
          selectedOption={sessionOption}
          workspaceId={workspaceId}
        />
        <FilterSelect
          label="Stage"
          name="stageId"
          options={[
            { label: "Any stage", value: "" },
            ...(stageUnavailable ? [{ label: "Stage unavailable", value: query.stageId! }] : []),
            ...(stages ?? []).map((option) => ({ label: option.label, value: option.id })),
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
      {stages === null ? (
        <p className="mt-2 text-xs text-muted">
          Stage choices couldn’t load. Refresh to try again.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 text-xs text-muted [&:not(:empty)]:mt-2">
        {query.sessionId && !sessionOption ? (
          <Link
            className="underline underline-offset-4 hover:text-foreground"
            href={runsListPageHref(
              workspaceSlug,
              { ...query, sessionId: undefined },
              undefined,
              factoryQuery,
            )}
          >
            Clear unavailable session
          </Link>
        ) : null}
        {stageUnavailable ? (
          <Link
            className="underline underline-offset-4 hover:text-foreground"
            href={runsListPageHref(
              workspaceSlug,
              { ...query, stageId: undefined },
              undefined,
              factoryQuery,
            )}
          >
            Clear unavailable stage
          </Link>
        ) : null}
        {agentId ? (
          <p className="break-words">
            {promptFilterLabel ?? "Recorded prompt revision unavailable"}
            {" · "}
            <Link
              className="underline underline-offset-4 hover:text-foreground"
              href={runsListPageHref(
                workspaceSlug,
                { ...query, agentId: undefined, agentPromptRevisionId: undefined },
                undefined,
                factoryQuery,
              )}
            >
              Clear prompt revision
            </Link>
          </p>
        ) : null}
      </div>
      <span className="sr-only" role="status">
        {pending ? "Loading filtered runs…" : ""}
      </span>
    </form>
  );
}

function FilterSelect({
  label,
  name,
  options,
  value,
  wrap,
}: {
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
      key={value ?? ""}
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
