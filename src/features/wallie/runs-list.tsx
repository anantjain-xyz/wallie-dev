import type { ReactNode } from "react";
import Link from "next/link";

import { formatUtcTimestamp } from "@/components/shared/time-format";
import { TimeDisplay } from "@/components/shared/time-display";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { Status, agentRunStatusValue } from "@/components/ui/status";
import { withFactoryQuery } from "@/features/factories/factory-selection";
import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import type { RunsListData } from "@/features/wallie/runs-list-data";
import { RunsListFilters, RunsListRefresh } from "@/features/wallie/runs-list-filters";
import {
  RUN_PROVIDER_LABELS,
  runCatalogActivityWarning,
  runCatalogCostLabel,
  runCatalogRecoveryLabel,
  runFromListHref,
  runsListHasFilters,
  runsListPageHref,
} from "@/features/wallie/runs-list-state";
import { workspaceSessionsPath } from "@/lib/routes";

export function RunsList({
  data,
  initialNow,
  factoryQuery,
  factoryName,
  factorySelector,
}: {
  data: RunsListData;
  initialNow: string;
  factoryQuery?: string;
  factoryName?: string;
  factorySelector?: ReactNode;
}) {
  const { workspaceSlug, query, state } = data;
  const runs = state.kind === "ready" ? state.page.runs : [];
  const latestHref = runsListPageHref(workspaceSlug, query, undefined, factoryQuery);
  const sessionsHref = withFactoryQuery(workspaceSessionsPath(workspaceSlug), factoryQuery);
  const filtered = runsListHasFilters(query);

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={
          <>
            {factorySelector}
            {state.kind === "error" ? null : <RunsListRefresh />}
          </>
        }
        actionsRightOnDesktop
        className="mb-4 sm:mb-5"
        title="Runs"
      />
      <RunsListFilters
        key={factoryQuery}
        factoryQuery={factoryQuery}
        invalidQuery={state.kind === "invalid-query"}
        query={query}
        sessionOption={data.sessionOption}
        stages={data.stages}
        promptFilterLabel={data.promptFilterLabel}
        workspaceId={data.workspaceId}
        workspaceSlug={workspaceSlug}
      />

      {state.kind !== "ready" ? (
        <section className="ui-sheet px-6 py-12 text-center" role="alert">
          <h2 className="text-sm font-semibold text-foreground">
            {state.kind === "error"
              ? "Runs couldn’t load"
              : "This run list link is no longer valid"}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {state.kind === "error"
              ? "Try again to load the runs."
              : state.kind === "invalid-query"
                ? "Clear the filters to load the latest runs."
                : "Start with the latest runs for these filters."}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {state.kind === "error" ? <RunsListRefresh label="Try again" /> : null}
            {state.kind === "invalid-cursor" ? (
              <Link className="ui-button" href={latestHref}>
                Latest runs
              </Link>
            ) : null}
          </div>
        </section>
      ) : runs.length === 0 ? (
        <section className="ui-sheet border-dashed px-6 py-14 text-center">
          <h2 className="text-sm font-semibold text-foreground">
            {query.cursor ? "No older runs" : filtered ? "No matching runs" : "No runs yet"}
          </h2>
          {query.cursor ? (
            <Link className="ui-button mt-4" href={latestHref}>
              Latest runs
            </Link>
          ) : filtered ? null : (
            <>
              <p className="mt-2 text-sm text-muted">
                Runs appear here when a session starts work.
              </p>
              <Link className="ui-button mt-4" href={sessionsHref}>
                View sessions
              </Link>
            </>
          )}
        </section>
      ) : (
        <>
          <p className="sr-only" role="status">
            {runs.length} {runs.length === 1 ? "run" : "runs"} on this page
          </p>
          <ol
            aria-label={factoryName ? `Runs in ${factoryName}` : "Runs"}
            className="ui-sheet divide-y divide-border"
          >
            {runs.map((run) => (
              <RunListRow
                key={run.id}
                factoryName={data.factoryNames?.[run.factoryId]}
                initialNow={initialNow}
                run={run}
                href={runFromListHref(workspaceSlug, run.id, query, factoryQuery)}
              />
            ))}
          </ol>
          {query.cursor || state.page.nextCursor ? (
            <nav aria-label="Run list pages" className="mt-5 flex flex-wrap justify-end gap-2">
              {query.cursor ? (
                <Link className="ui-button" href={latestHref} prefetch={false}>
                  Latest runs
                </Link>
              ) : null}
              {state.page.nextCursor ? (
                <Link
                  className="ui-button"
                  href={runsListPageHref(workspaceSlug, query, state.page.nextCursor, factoryQuery)}
                  prefetch={false}
                >
                  Older runs
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      )}
    </PageContainer>
  );
}

function RunListRow({
  factoryName,
  run,
  href,
  initialNow,
}: {
  factoryName?: string;
  run: WorkspaceRunCatalogItem;
  href: string;
  initialNow: string;
}) {
  const recovery = runCatalogRecoveryLabel(run);
  const retryAt =
    run.recovery?.queue.state === "retry_scheduled" ? run.recovery.queue.scheduledAt : null;
  const attemptLabel = run.stageOrdinal === null ? null : `Attempt ${run.stageOrdinal}`;
  const activityWarning = runCatalogActivityWarning(run);
  const cost = runCatalogCostLabel(run);
  return (
    <li className="grid min-w-0 items-start gap-x-5 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5">
      <div className="min-w-0">
        <Link
          aria-label={`${run.sessionTitle} — ${run.stageName ?? "Session"}, ${attemptLabel?.toLowerCase() ?? `created ${formatUtcTimestamp(run.createdAt)}`}`}
          className="text-sm font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-current [overflow-wrap:anywhere]"
          href={href}
          prefetch={false}
        >
          {run.sessionTitle}
        </Link>
        <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
          <Link
            aria-label={`Session #${run.sessionNumber}`}
            className="font-mono underline underline-offset-2 hover:text-foreground"
            href={run.sessionRunHref}
          >
            #{run.sessionNumber}
          </Link>
          {" · "}
          {run.stageName ?? "Session run"}
          {attemptLabel ? ` · ${attemptLabel}` : null}
          {factoryName ? ` · ${factoryName}` : null}
        </p>
        <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
          {RUN_PROVIDER_LABELS[run.modelProvider] ?? run.modelProvider} · {run.modelName}
        </p>
        {run.status === "error" ? (
          <p className="mt-2 text-xs text-foreground">
            {run.failure?.categoryLabel ?? "Cause not recorded"}
          </p>
        ) : null}
        {recovery ? (
          <p className="mt-2 text-xs text-warning">
            {recovery}
            {retryAt ? (
              <>
                {" "}
                · <TimeDisplay initialNow={initialNow} value={retryAt} />
              </>
            ) : null}
          </p>
        ) : null}
        {activityWarning ? <p className="mt-1 text-xs text-muted">{activityWarning}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted sm:flex-col sm:items-end">
        <Status
          compact
          label={
            run.interrupted ? "Interrupted" : run.status === "started" ? "Starting" : undefined
          }
          value={agentRunStatusValue(run.status)}
        />
        <TimeDisplay initialNow={initialNow} value={run.createdAt} variant="relative" />
        {cost ? <p className="tabular-nums">{cost}</p> : null}
      </div>
    </li>
  );
}
