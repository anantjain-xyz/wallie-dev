"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useState, useTransition } from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField } from "@/components/ui/select";
import {
  activityActorSearchHref,
  activityHref,
  type ActivityActorSearch,
  type ActivityQuery,
  type ActivityRunStatus,
} from "@/features/factory-activity/activity-query";

type FilterProps = { query: ActivityQuery; workspaceSlug: string };

const statuses = {
  queued: "Queued",
  started: "Starting",
  running: "Running",
  success: "Complete",
  error: "Failed or interrupted",
  canceled: "Canceled",
} satisfies Record<ActivityRunStatus, string>;

const statusOptions = [
  { label: "All statuses", value: "" },
  ...Object.entries(statuses).map(([value, label]) => ({ label, value })),
];

export function ActivityStatusFilter({ query, workspaceSlug }: FilterProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [status, showStatus] = useOptimistic(query.status);

  return (
    <SelectField
      className="min-w-0 max-w-full"
      label="Run status"
      labelClassName="text-xs text-muted"
      name="status"
      onValueChange={(value) => {
        if (value && !Object.hasOwn(statuses, value)) return;
        const nextStatus = (value || undefined) as ActivityRunStatus | undefined;
        if (status === nextStatus) return;
        const href = activityHref(workspaceSlug, {
          ...query,
          status: nextStatus,
          runsBefore: undefined,
        });
        startTransition(() => {
          showStatus(nextStatus);
          router.push(href, { scroll: false });
        });
      }}
      options={statusOptions}
      triggerClassName={`max-w-full ${FILTER_CONTROL_CLASS}`}
      value={status ?? ""}
    />
  );
}

export function ActivityActorFilter({
  label,
  query,
  workspaceSlug,
}: FilterProps & { label: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <div className="min-w-0 max-w-full space-y-1.5">
        <span className="block text-xs text-muted">Actor</span>
        <DialogTrigger
          aria-label={`Actor: ${label}`}
          className={`ui-button min-w-0 max-w-full gap-2 sm:max-w-64 ${FILTER_CONTROL_CLASS}`}
        >
          <span className="truncate">{label}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
        </DialogTrigger>
      </div>
      <DialogContent
        description="Find people or systems with access or recorded activity in this factory scope."
        title="Filter by actor"
      >
        {open ? (
          <ActivityActorSearchForm
            key={query.factory}
            onChoose={() => setOpen(false)}
            query={query}
            workspaceSlug={workspaceSlug}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ActivityActorSearchForm({
  onChoose,
  query,
  workspaceSlug,
}: FilterProps & { onChoose: () => void }) {
  const [input, setInput] = useState("");
  const [retry, setRetry] = useState(0);
  const term = input.trim().replace(/^@/, "");
  const [response, setResponse] = useState<{
    term: string;
    retry: number;
    result: ActivityActorSearch | null;
  }>();
  const result = response?.term === term && response.retry === retry ? response.result : undefined;

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      async () => {
        let result: ActivityActorSearch | null = null;
        try {
          const response = await fetch(
            activityActorSearchHref(workspaceSlug, query.factory, term),
            {
              signal: controller.signal,
              cache: "no-store",
            },
          );
          if (response.ok) result = (await response.json()) as ActivityActorSearch;
        } catch {
          result = null;
        }
        if (!controller.signal.aborted) setResponse({ term, retry, result });
      },
      term ? 220 : 0,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [query.factory, retry, term, workspaceSlug]);

  const choices = [{ label: "All actors", id: undefined }, ...(result?.actors ?? [])];

  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="type-label">Search actors</span>
        <input
          autoComplete="off"
          className="ui-input w-full"
          maxLength={100}
          name="actor-search"
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder="Name or @username…"
          spellCheck={false}
          type="search"
          value={input}
        />
      </label>
      <ul
        aria-label="Actor choices"
        className="max-h-[min(18rem,42dvh)] divide-y divide-border overflow-y-auto"
      >
        {choices.map(({ id, label }) => (
          <li key={id ?? "all"}>
            <Link
              aria-current={id === query.actor ? "true" : undefined}
              className="flex min-h-11 items-center justify-between gap-3 px-2 py-2 text-sm text-foreground hover:bg-control-hover [overflow-wrap:anywhere]"
              href={activityHref(workspaceSlug, {
                factory: query.factory,
                status: query.status,
                actor: id,
              })}
              onNavigate={onChoose}
              prefetch={false}
              scroll={false}
            >
              <span>{label}</span>
              {id === query.actor ? <span className="text-xs text-muted">Selected</span> : null}
            </Link>
          </li>
        ))}
      </ul>
      <p className="type-secondary text-muted" role="status">
        {result === undefined
          ? "Loading actors…"
          : result === null
            ? "Actor choices are unavailable."
            : result.actors.length === 0
              ? "No named actors match."
              : result.hasMore
                ? "Refine your search to see more actors."
                : `${result.actors.length} ${result.actors.length === 1 ? "actor" : "actors"} found.`}
      </p>
      {result === null ? (
        <button className="ui-button" onClick={() => setRetry(retry + 1)} type="button">
          Retry actor search
        </button>
      ) : null}
    </div>
  );
}
