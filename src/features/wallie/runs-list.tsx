import Link from "next/link";

import { TimeDisplay } from "@/components/shared/time-display";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { Status, agentRunStatusValue } from "@/components/ui/status";
import { withFactoryQuery } from "@/features/factories/factory-selection";
import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import type { RunsListData } from "@/features/wallie/runs-list-data";
import { RunsListFilters, RunsListRefresh } from "@/features/wallie/runs-list-filters";
import {
  RUN_PROVIDER_LABELS,
  runCatalogActivityLabel,
  runCatalogCostLabel,
  runCatalogRecoveryLabel,
  runsListHasFilters,
  runsListPageHref,
} from "@/features/wallie/runs-list-state";
import { workspaceRunDetailPath, workspaceRunsPath, workspaceSessionsPath } from "@/lib/routes";

export function RunsList({
  data,
  initialNow,
  factoryQuery,
}: {
  data: RunsListData;
  initialNow: string;
  factoryQuery?: string;
}) {
  const { workspaceSlug, query, state } = data;
  const runs = state.kind === "ready" ? state.page.runs : [];
  const sessions = [
    ...new Map(
      runs.map((run) => [
        run.sessionId,
        {
          id: run.sessionId,
          label: `#${run.sessionNumber} ${run.sessionTitle}`,
        },
      ]),
    ).values(),
  ];
  const stages = [
    ...new Map(
      runs.flatMap((run) =>
        run.stageId
          ? [
              [
                run.stageId,
                {
                  id: run.stageId,
                  label: run.stageName ?? "Unnamed stage",
                },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  const latestHref = runsListPageHref(workspaceSlug, query, undefined, factoryQuery);
  const sessionsHref = withFactoryQuery(workspaceSessionsPath(workspaceSlug), factoryQuery);

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={<RunsListRefresh />}
        description="Every execution attempt across your workspace. Open a run to inspect its activity and outcome."
        eyebrow={
          <Link className="hover:text-foreground" href={sessionsHref}>
            ← Sessions
          </Link>
        }
        eyebrowAsPlain
        title="Runs"
      />
      <RunsListFilters
        key={JSON.stringify({ factoryQuery, query })}
        factoryQuery={factoryQuery}
        query={query}
        sessions={sessions}
        stages={stages}
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
              ? "Try again to load this page."
              : "Start with the latest runs or adjust your filters."}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {state.kind === "error" ? <RunsListRefresh label="Try again" /> : null}
            <Link className="ui-button" href={latestHref}>
              Latest runs
            </Link>
          </div>
        </section>
      ) : runs.length === 0 ? (
        <section className="ui-sheet border-dashed px-6 py-14 text-center">
          <h2 className="text-sm font-semibold text-foreground">
            {query.cursor
              ? "No older runs"
              : runsListHasFilters(query)
                ? "No matching runs"
                : "No runs yet"}
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted">
            {query.cursor
              ? "You’ve reached the end of this list."
              : runsListHasFilters(query)
                ? "Adjust the filters to find another execution attempt."
                : "Runs appear here when a session starts work. Each attempt keeps its own activity and outcome."}
          </p>
          <Link
            className="ui-button mt-5"
            href={
              query.cursor
                ? latestHref
                : runsListHasFilters(query)
                  ? withFactoryQuery(workspaceRunsPath(workspaceSlug), factoryQuery)
                  : sessionsHref
            }
          >
            {query.cursor
              ? "Latest runs"
              : runsListHasFilters(query)
                ? "Clear filters"
                : "View sessions"}
          </Link>
        </section>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <p>
              {runs.length} {runs.length === 1 ? "run" : "runs"} on this page
            </p>
            <p>Newest first{query.cursor ? " · Older runs" : ""}</p>
          </div>
          <ol aria-label="Runs" className="ui-sheet divide-y divide-border">
            {runs.map((run) => (
              <RunListRow
                key={run.id}
                initialNow={initialNow}
                run={run}
                workspaceSlug={workspaceSlug}
              />
            ))}
          </ol>
          <nav
            aria-label="Run list pages"
            className="mt-5 flex flex-wrap items-center justify-between gap-3"
          >
            <div className="text-xs text-muted">
              {query.cursor ? (
                <Link className="text-foreground underline underline-offset-4" href={latestHref}>
                  Back to latest
                </Link>
              ) : (
                "Refresh to see new runs."
              )}
            </div>
            {state.page.nextCursor ? (
              <Link
                className="ui-button"
                href={runsListPageHref(workspaceSlug, query, state.page.nextCursor, factoryQuery)}
              >
                Older runs →
              </Link>
            ) : (
              <span className="text-xs text-muted">End of list</span>
            )}
          </nav>
        </>
      )}
    </PageContainer>
  );
}

function RunListRow({
  run,
  workspaceSlug,
  initialNow,
}: {
  run: WorkspaceRunCatalogItem;
  workspaceSlug: string;
  initialNow: string;
}) {
  const recovery = runCatalogRecoveryLabel(run);
  return (
    <li className="grid min-w-0 gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] sm:px-5">
      <div className="min-w-0">
        <Link
          className="text-[14px] font-semibold leading-6 text-foreground hover:underline [overflow-wrap:anywhere]"
          href={workspaceRunDetailPath(workspaceSlug, run.id)}
        >
          {run.sessionTitle}
          <span className="sr-only">
            {" "}
            — {run.stageName ?? "Session"},{" "}
            {run.attemptCount === null ? "unassigned attempt" : `attempt ${run.attemptCount}`}
          </span>
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Link className="font-mono hover:text-foreground" href={run.sessionRunHref}>
            #{run.sessionNumber}
          </Link>
          <span aria-hidden="true">·</span>
          <span>{run.stageName ?? "Session run"}</span>
          <span aria-hidden="true">·</span>
          <span>
            {run.attemptCount === null ? "Attempt not assigned" : `Attempt ${run.attemptCount}`}
          </span>
        </div>
        {recovery ? <p className="mt-2 text-xs text-warning">{recovery}</p> : null}
      </div>
      <div className="min-w-0 space-y-2">
        <Status
          compact
          label={
            run.interrupted ? "Interrupted" : run.status === "started" ? "Starting" : undefined
          }
          value={agentRunStatusValue(run.status)}
        />
        <p className="break-words text-xs text-muted">
          {RUN_PROVIDER_LABELS[run.modelProvider] ?? run.modelProvider} · {run.modelName}
        </p>
        <p className="text-xs text-muted">{runCatalogActivityLabel(run)}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted sm:block sm:space-y-2 sm:text-right">
        <div>
          <TimeDisplay initialNow={initialNow} value={run.createdAt} variant="relative" />
        </div>
        <p className="tabular-nums">{runCatalogCostLabel(run)}</p>
        <Link
          className="inline-flex min-h-9 items-center text-foreground underline-offset-4 hover:underline"
          href={workspaceRunDetailPath(workspaceSlug, run.id)}
          aria-label={`Inspect run for session ${run.sessionNumber}, ${run.stageName ?? "session"}, attempt ${run.attemptCount ?? "not assigned"}`}
        >
          Inspect run →
        </Link>
      </div>
    </li>
  );
}
