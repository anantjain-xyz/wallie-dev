import type { ReactNode } from "react";
import Link from "next/link";

import { TimeDisplay } from "@/components/shared/time-display";
import { FILTER_BAR_CLASS, FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import type {
  ActivitySection,
  FactoryActivityData,
} from "@/features/factory-activity/activity-data";
import {
  ActivityActorFilter,
  ActivityStatusFilter,
} from "@/features/factory-activity/activity-filters";
import {
  ACTIVITY_CURSOR_PARAM,
  activityHref,
  type ActivityKind,
  type ActivityQuery,
} from "@/features/factory-activity/activity-query";
import { ActivityRefresh } from "@/features/factory-activity/activity-refresh";
import { workspaceRunsPath, workspaceSessionsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

const textLink = "underline underline-offset-2 hover:text-foreground";

export function FactoryActivityPage({
  actorLabel,
  data,
  factorySelector,
  invalidCursors,
  invalidStatus,
  query,
  workspaceSlug,
}: {
  actorLabel: string;
  data: FactoryActivityData;
  factorySelector?: ReactNode;
  invalidCursors?: Record<ActivityKind, boolean>;
  invalidStatus?: boolean;
  query: ActivityQuery;
  workspaceSlug: string;
}) {
  const { sessions, runs, capturedAt } = data;
  const hasSnapshot = sessions.kind === "available" || runs.kind === "available";

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={
          <>
            {factorySelector}
            <ActivityRefresh capturedAt={hasSnapshot ? capturedAt : null} />
          </>
        }
        actionsRightOnDesktop
        className="mb-4 sm:mb-5"
        title="Activity"
      />
      <div className="space-y-5">
        <div
          aria-label="Activity filters"
          className={cn(FILTER_BAR_CLASS, "min-w-0 items-end")}
          role="group"
        >
          <ActivityActorFilter label={actorLabel} query={query} workspaceSlug={workspaceSlug} />
          <ActivityStatusFilter query={query} workspaceSlug={workspaceSlug} />
          {query.actor || query.status || invalidStatus ? (
            <Link
              className={`ui-button ${FILTER_CONTROL_CLASS}`}
              href={activityHref(workspaceSlug, { factory: query.factory })}
              prefetch={false}
              scroll={false}
            >
              Clear filters
            </Link>
          ) : null}
        </div>
        <ActivityList
          initialNow={capturedAt}
          invalidCursor={invalidCursors?.sessions}
          kind="sessions"
          query={query}
          section={sessions}
          workspaceSlug={workspaceSlug}
        />
        <ActivityList
          initialNow={capturedAt}
          invalidCursor={invalidCursors?.runs}
          invalidStatus={invalidStatus}
          kind="runs"
          query={query}
          section={runs}
          workspaceSlug={workspaceSlug}
        />
      </div>
    </PageContainer>
  );
}

function ActivityList({
  initialNow,
  invalidCursor,
  invalidStatus,
  kind,
  query,
  section,
  workspaceSlug,
}: {
  initialNow: string;
  invalidCursor?: boolean;
  invalidStatus?: boolean;
  kind: ActivityKind;
  query: ActivityQuery;
  section: ActivitySection;
  workspaceSlug: string;
}) {
  const isSessions = kind === "sessions";
  const heading = isSessions ? "Sessions" : "Runs";
  const headingId = "activity-" + kind + "-heading";
  const cursorParam = ACTIVITY_CURSOR_PARAM[kind];
  const hasOlderPosition = Boolean(query[cursorParam]);
  const latestQuery = { ...query, [cursorParam]: undefined };
  const latestHref = activityHref(workspaceSlug, latestQuery, kind);
  const browseHref = isSessions
    ? workspaceSessionsPath(workspaceSlug, { factory: query.factory, scope: "all" })
    : workspaceRunsPath(workspaceSlug, { factory: query.factory, status: query.status });
  const filtered = query.actor || (!isSessions && query.status);

  return (
    <section
      aria-labelledby={headingId}
      className="ui-sheet scroll-mt-20"
      id={`activity-${kind}`}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2 className="type-section-title" id={headingId}>
            {heading}
          </h2>
          {section.kind === "available" ? (
            <p className="text-xs text-muted tabular-nums" role="status">
              {section.count.toLocaleString("en-US")}{" "}
              {section.count === 1 ? (isSessions ? "session" : "run") : kind}
              {filtered ? (section.count === 1 ? " matches" : " match") : null}
            </p>
          ) : null}
        </div>
        {!query.actor && section.kind === "available" && section.count > 0 ? (
          <Link className="ui-button" href={browseHref}>
            View {kind}
          </Link>
        ) : null}
      </div>
      {invalidCursor || invalidStatus ? (
        <p className="border-b border-border px-4 py-3 text-sm text-muted sm:px-5">
          {invalidCursor ? "This page link is unavailable. Showing the latest results. " : null}
          {invalidStatus ? "This status filter is unavailable. Showing all statuses. " : null}
          {invalidCursor ? (
            <Link className={textLink} href={latestHref}>
              Latest {kind}
            </Link>
          ) : null}
        </p>
      ) : null}
      {section.kind === "unavailable" ? (
        <p className="px-4 py-8 text-sm text-muted sm:px-5">
          {heading} activity is unavailable. Use Refresh to try again.
        </p>
      ) : section.rows.length === 0 ? (
        <div className="space-y-3 px-4 py-8 text-sm text-muted sm:px-5">
          <p>
            {hasOlderPosition
              ? `No older ${kind} match this view.`
              : filtered
                ? `No ${kind} match these filters.`
                : query.factory !== "all"
                  ? `No ${kind} in this factory.`
                  : `No ${kind} yet.`}
          </p>
          {!hasOlderPosition && !filtered && query.factory === "all" ? (
            <Link className={textLink} href={browseHref}>
              View {kind}
            </Link>
          ) : null}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {section.rows.map((row) => (
            <li
              className="grid min-w-0 gap-x-5 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_8rem] sm:px-5"
              key={row.id}
            >
              <div className="min-w-0">
                <Link
                  className="text-sm font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-current [overflow-wrap:anywhere]"
                  href={row.href}
                >
                  {row.title}
                </Link>
                {row.description ? (
                  <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
                    {row.description}
                  </p>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 text-xs text-muted [overflow-wrap:anywhere] sm:flex-col">
                <Link
                  className={textLink}
                  href={activityHref(workspaceSlug, {
                    factory: row.factory.id,
                    actor: query.actor,
                    status: query.status,
                  })}
                  prefetch={false}
                  scroll={false}
                >
                  {row.factory.name}
                </Link>
                <p>
                  {isSessions ? "Created by " : "Triggered by "}
                  {row.actor ? (
                    <Link
                      className={textLink}
                      href={activityHref(workspaceSlug, {
                        factory: query.factory,
                        actor: row.actor.id,
                        status: query.status,
                      })}
                      prefetch={false}
                      scroll={false}
                    >
                      {row.actor.label}
                    </Link>
                  ) : (
                    "unrecorded actor"
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted sm:flex-col sm:items-end">
                <Status compact value={row.status} />
                <p>
                  {isSessions ? "Updated " : "Created "}
                  <TimeDisplay initialNow={initialNow} value={row.time} variant="relative" />
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {section.kind === "available" && (hasOlderPosition || section.olderQuery) ? (
        <nav
          aria-label={`${heading} pages`}
          className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3 sm:px-5"
        >
          {hasOlderPosition ? (
            <Link className="ui-button" href={latestHref} prefetch={false}>
              Latest {kind}
            </Link>
          ) : null}
          {section.olderQuery ? (
            <Link
              className="ui-button"
              href={activityHref(workspaceSlug, section.olderQuery, kind)}
              prefetch={false}
            >
              Older {kind}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
