import type { ReactNode } from "react";
import Link from "next/link";

import { TimeDisplay } from "@/components/shared/time-display";
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
            <ActivityActorFilter label={actorLabel} query={query} workspaceSlug={workspaceSlug} />
            <ActivityRefresh capturedAt={hasSnapshot ? capturedAt : null} />
          </>
        }
        actionsRightOnDesktop
        title="Activity"
      />
      <div className="space-y-5">
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
  const filtered = query.factory !== "all" || query.actor || (!isSessions && query.status);

  return (
    <section
      aria-labelledby={headingId}
      className="ui-sheet scroll-mt-20"
      id={`activity-${kind}`}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h2 className="type-section-title" id={headingId}>
            {heading}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {isSessions ? "Most recently updated first" : "Most recently created first"}
          </p>
          {section.kind === "available" ? (
            <p className="mt-1 text-xs text-muted" role="status">
              {section.count.toLocaleString("en-US")}{" "}
              {section.count === 1 ? (isSessions ? "session" : "run") : kind}{" "}
              {filtered ? (section.count === 1 ? "matches" : "match") : "in this scope"}
              {section.rows.length > 0 && (section.count > section.rows.length || hasOlderPosition)
                ? ` · Showing ${section.rows.length} ${hasOlderPosition ? "older" : "latest"}`
                : null}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-end gap-2">
          {isSessions ? null : <ActivityStatusFilter query={query} workspaceSlug={workspaceSlug} />}
          {!query.actor && section.kind === "available" && section.count > 0 ? (
            <Link className="ui-button" href={browseHref}>
              View {kind}
            </Link>
          ) : null}
        </div>
      </div>
      {invalidCursor || invalidStatus ? (
        <p className="border-b border-border px-4 py-3 text-sm text-muted sm:px-5">
          {invalidCursor ? "This page link is unavailable. Showing the latest results. " : null}
          {invalidStatus ? "This status filter is unavailable. Showing all statuses. " : null}
          <Link className={textLink} href={latestHref}>
            Reset link
          </Link>
        </p>
      ) : null}
      {section.kind === "unavailable" ? (
        <p className="px-4 py-8 text-sm text-muted sm:px-5">
          {heading} activity is unavailable. Use Refresh at the top of Activity to try again.
        </p>
      ) : section.rows.length === 0 ? (
        <div className="space-y-3 px-4 py-8 text-sm text-muted sm:px-5">
          <p>
            {hasOlderPosition
              ? `No older ${kind} match this view.`
              : filtered
                ? `No ${kind} match these filters.`
                : `No ${kind} yet.`}
          </p>
          {hasOlderPosition ? null : filtered ? (
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {query.actor ? (
                <Link
                  className={textLink}
                  href={activityHref(workspaceSlug, {
                    factory: query.factory,
                    status: query.status,
                  })}
                  scroll={false}
                >
                  Clear actor filter
                </Link>
              ) : null}
              {query.factory !== "all" ? (
                <Link
                  className={textLink}
                  href={activityHref(workspaceSlug, {
                    factory: "all",
                    actor: query.actor,
                    status: query.status,
                  })}
                  scroll={false}
                >
                  Show all accessible factories
                </Link>
              ) : null}
              {!isSessions && query.status ? (
                <Link
                  className={textLink}
                  href={activityHref(workspaceSlug, { ...latestQuery, status: undefined })}
                  scroll={false}
                >
                  Clear status filter
                </Link>
              ) : null}
            </div>
          ) : (
            <Link className={textLink} href={browseHref}>
              View {kind}
            </Link>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {section.rows.map((row) => (
            <li
              className="grid min-w-0 gap-x-6 gap-y-2 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,180px)_auto] sm:px-5"
              key={row.id}
            >
              <div className="min-w-0">
                <Link
                  className="font-semibold text-foreground hover:underline [overflow-wrap:anywhere]"
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
              <div className="grid min-w-0 content-start gap-1 text-xs text-muted [overflow-wrap:anywhere]">
                <Link
                  className={`justify-self-start ${textLink}`}
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>Current status:</span>
                  <Status compact value={row.status} />
                </div>
                <p>
                  {isSessions ? "Last updated " : "Run created "}
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
