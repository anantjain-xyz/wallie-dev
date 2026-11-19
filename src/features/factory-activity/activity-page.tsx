import Link from "next/link";

import { TimeDisplay } from "@/components/shared/time-display";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import type {
  ActivitySection,
  FactoryActivityData,
} from "@/features/factory-activity/activity-data";
import { ActivityRefresh } from "@/features/factory-activity/activity-refresh";
import { workspaceActivityPath, workspaceRunsPath, workspaceSessionsPath } from "@/lib/routes";

type ActivityScope = { id: string; label: string };

export function FactoryActivityPage({
  data,
  workspaceSlug,
  factory,
  actorId,
}: {
  data: FactoryActivityData;
  workspaceSlug: string;
  factory: ActivityScope;
  actorId?: string;
}) {
  const { sessions, runs, capturedAt } = data;
  const hasSnapshot = sessions.kind === "available" || runs.kind === "available";
  const actorRows = [
    ...(sessions.kind === "available" ? sessions.rows : []),
    ...(runs.kind === "available" ? runs.rows : []),
  ];
  const actorLabel = actorRows.find((row) => row.actor?.id === actorId)?.actor?.label ?? actorId;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={<ActivityRefresh capturedAt={hasSnapshot ? capturedAt : null} />}
        actionsRightOnDesktop
        title="Activity"
      />
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        <p>{factory.label}</p>
        {actorId ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-all">Actor · {actorLabel}</span>
            <Link
              className="underline underline-offset-2 hover:text-foreground"
              href={workspaceActivityPath(workspaceSlug, { factory: factory.id })}
            >
              Clear actor filter
            </Link>
          </p>
        ) : null}
      </div>
      <div className="space-y-5">
        <ActivityList
          actorId={actorId}
          browseHref={workspaceSessionsPath(workspaceSlug, { factory: factory.id, scope: "all" })}
          factoryId={factory.id}
          initialNow={capturedAt}
          kind="sessions"
          section={sessions}
          workspaceSlug={workspaceSlug}
        />
        <ActivityList
          actorId={actorId}
          browseHref={workspaceRunsPath(workspaceSlug, { factory: factory.id })}
          factoryId={factory.id}
          initialNow={capturedAt}
          kind="runs"
          section={runs}
          workspaceSlug={workspaceSlug}
        />
      </div>
    </PageContainer>
  );
}

function ActivityList({
  actorId,
  browseHref,
  factoryId,
  initialNow,
  kind,
  section,
  workspaceSlug,
}: {
  actorId?: string;
  browseHref: string;
  factoryId: string;
  initialNow: string;
  kind: "sessions" | "runs";
  section: ActivitySection;
  workspaceSlug: string;
}) {
  const isSessions = kind === "sessions";
  const heading = isSessions ? "Sessions" : "Runs";
  const headingId = "activity-" + kind;

  return (
    <section aria-labelledby={headingId} className="ui-sheet">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div>
          <h2 className="text-sm font-semibold text-foreground" id={headingId}>
            {heading}
          </h2>
          {section.kind === "available" ? (
            <p className="mt-1 text-xs text-muted">
              {section.count.toLocaleString("en-US")}{" "}
              {section.count === 1 ? (isSessions ? "session" : "run") : kind} in this scope
              {section.count > section.rows.length ? (
                <> · Showing {section.rows.length} most recent</>
              ) : null}
            </p>
          ) : null}
        </div>
        {!actorId ? (
          <Link className="ui-button" href={browseHref}>
            View {kind}
          </Link>
        ) : null}
      </div>
      {section.kind === "unavailable" ? (
        <p className="px-4 py-8 text-sm text-muted sm:px-5">{heading} activity is unavailable.</p>
      ) : section.count === 0 ? (
        <p className="px-4 py-8 text-sm text-muted sm:px-5">No {kind} in this scope.</p>
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
                  <p className="mt-1 break-words text-xs text-muted">{row.description}</p>
                ) : null}
              </div>
              <div className="grid content-start gap-1 text-xs text-muted">
                <Link
                  className="underline underline-offset-2 hover:text-foreground justify-self-start [overflow-wrap:anywhere]"
                  href={workspaceActivityPath(workspaceSlug, {
                    factory: row.factory.id,
                    actor: actorId,
                  })}
                  prefetch={false}
                >
                  {row.factory.name}
                </Link>
                <p className="break-words">
                  {isSessions ? "Created by " : "Triggered by "}
                  {row.actor ? (
                    <Link
                      className="underline underline-offset-2 hover:text-foreground"
                      href={workspaceActivityPath(workspaceSlug, {
                        factory: factoryId,
                        actor: row.actor.id,
                      })}
                      prefetch={false}
                      title={row.actor.id}
                    >
                      {row.actor.label}
                    </Link>
                  ) : (
                    "unrecorded actor"
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                <Status compact value={row.status} />
                <TimeDisplay
                  className="text-xs text-muted"
                  initialNow={initialNow}
                  value={row.occurredAt}
                  variant="relative"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
