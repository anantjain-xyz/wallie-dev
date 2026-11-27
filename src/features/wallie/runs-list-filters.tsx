"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField, type SelectOption } from "@/components/ui/select";
import type { RunCatalogQuery } from "@/features/wallie/run-catalog-contracts";
import { RunSessionFilter } from "@/features/wallie/run-session-filter";
import type { RunSessionOption, RunStageOption } from "@/features/wallie/runs-list-options";
import {
  RUN_PROVIDER_LABELS,
  runsListHasFilters,
  runsListPageHref,
} from "@/features/wallie/runs-list-state";

export function RunsListFilters({
  workspaceId,
  workspaceSlug,
  factoryQuery,
  query,
  sessionOption,
  stages,
  promptFilterLabel,
  invalidQuery,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factoryQuery?: string;
  query: RunCatalogQuery;
  sessionOption?: RunSessionOption | null;
  stages?: RunStageOption[] | null;
  promptFilterLabel?: string | null;
  invalidQuery: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, showFilters] = useOptimistic({ query, sessionOption });
  const { status, provider, sessionId, stageId, agentId } = draft.query;
  const stageUnavailable = stageId && !stages?.some((option) => option.id === stageId);

  function apply(filters: Partial<RunCatalogQuery>, sessionOption = draft.sessionOption) {
    const next = { ...draft.query, ...filters, cursor: undefined };
    startTransition(() => {
      showFilters({ query: next, sessionOption });
      router.push(runsListPageHref(workspaceSlug, next, undefined, factoryQuery), {
        scroll: false,
      });
    });
  }

  return (
    <div aria-label="Run filters" className="mb-5 border-y border-border py-3" role="group">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <FilterSelect
          label="Status"
          name="status"
          onValueChange={(value) =>
            apply({ status: (value || undefined) as RunCatalogQuery["status"] })
          }
          options={[
            { label: "All statuses", value: "" },
            { label: "Queued", value: "queued" },
            { label: "Starting", value: "started" },
            { label: "Running", value: "running" },
            { label: "Complete", value: "success" },
            { label: "Failed or interrupted", value: "error" },
            { label: "Canceled", value: "canceled" },
          ]}
          value={status}
        />
        <FilterSelect
          label="Agent"
          name="provider"
          onValueChange={(value) =>
            apply({ provider: (value || undefined) as RunCatalogQuery["provider"] })
          }
          options={[
            { label: "All agents", value: "" },
            ...Object.entries(RUN_PROVIDER_LABELS).map(([value, label]) => ({ label, value })),
          ]}
          value={provider}
        />
        <RunSessionFilter
          factory={factoryQuery ?? "all"}
          onSelect={(option) => {
            if (option?.id !== sessionId) apply({ sessionId: option?.id }, option);
          }}
          selectedId={sessionId}
          selectedOption={draft.sessionOption}
          workspaceId={workspaceId}
        />
        <FilterSelect
          label="Stage"
          name="stageId"
          onValueChange={(value) => apply({ stageId: value || undefined })}
          options={[
            { label: "Any stage", value: "" },
            ...(stageUnavailable ? [{ label: "Stage unavailable", value: stageId }] : []),
            ...(stages ?? []).map((option) => ({ label: option.label, value: option.id })),
          ]}
          value={stageId}
          wrap
        />
        {invalidQuery || runsListHasFilters(draft.query) ? (
          <Link
            className={`ui-button ${FILTER_CONTROL_CLASS}`}
            href={runsListPageHref(workspaceSlug, { limit: query.limit }, undefined, factoryQuery)}
            prefetch={false}
            scroll={false}
          >
            Clear filters
          </Link>
        ) : null}
      </div>
      {stages === null ? (
        <p className="mt-2 text-xs text-muted">
          Stage choices couldn’t load. Refresh to try again.
        </p>
      ) : null}
      {agentId ? (
        <p className="mt-2 text-xs text-muted [overflow-wrap:anywhere]">
          Prompt revision: {promptFilterLabel ?? "Unavailable"}
        </p>
      ) : null}
      <span className="sr-only" role="status">
        {pending ? "Loading filtered runs…" : ""}
      </span>
    </div>
  );
}

function FilterSelect({
  label,
  name,
  onValueChange,
  options,
  value,
  wrap,
}: {
  label: string;
  name: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  value?: string;
  wrap?: boolean;
}) {
  return (
    <SelectField
      className="min-w-0 flex-1 basis-[140px] space-y-1"
      label={label}
      labelClassName="text-xs font-normal text-muted"
      name={name}
      onValueChange={(next) => {
        if (next !== (value ?? "")) onValueChange(next);
      }}
      options={options}
      triggerClassName={`max-w-full py-1.5 ${FILTER_CONTROL_CLASS}`}
      value={value ?? ""}
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
