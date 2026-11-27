"use client";

import Link from "next/link";

import { PAGE_HEADER_TITLE_CLASS } from "@/components/ui/page-shell";
import { PIPELINE_STATUS_FILTERS } from "@/features/pipeline/types";
import type { SessionDisplayStatus } from "@/features/sessions/display-status";
import { workspaceBasePath, workspaceSessionsPath } from "@/lib/routes";
import { startInteraction } from "@/lib/telemetry/interaction-rum";
import { cn } from "@/lib/utils";

type SessionsViewProps = {
  factory: string;
  status?: SessionDisplayStatus;
  view: "board" | "list";
  workspaceSlug: string;
};

export function SessionsViewNavigation({
  factory,
  status,
  view,
  workspaceSlug,
}: SessionsViewProps) {
  const sharedStatus = PIPELINE_STATUS_FILTERS.find((value) => value === status);
  const boardParams = new URLSearchParams({ factory });
  if (sharedStatus) boardParams.set("status", sharedStatus);
  const views = [
    { key: "board", name: "Board", href: `${workspaceBasePath(workspaceSlug)}?${boardParams}` },
    {
      key: "list",
      name: "List",
      href: workspaceSessionsPath(workspaceSlug, {
        factory,
        scope: "active",
        status: sharedStatus,
      }),
    },
  ] as const;
  const itemClass =
    "ui-shell-nav-link min-h-11 px-3 sm:min-h-9 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none";

  return (
    <nav aria-label="Sessions views" className="flex items-center gap-1">
      {views.map(({ key, name, href }) =>
        key === view ? (
          <span aria-current="page" className={cn(itemClass, "ui-shell-nav-link-active")} key={key}>
            {name}
          </span>
        ) : (
          <Link
            className={itemClass}
            href={href}
            key={key}
            onNavigate={
              key === "list"
                ? () =>
                    startInteraction(
                      "pipeline_to_sessions",
                      "/w/[workspaceSlug]",
                      "/w/[workspaceSlug]/sessions",
                    )
                : undefined
            }
          >
            {name}
          </Link>
        ),
      )}
    </nav>
  );
}

export function SessionsViewTitle(props: SessionsViewProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <h1 className={PAGE_HEADER_TITLE_CLASS}>Sessions</h1>
      <SessionsViewNavigation {...props} />
      {props.view === "board" ? (
        <p className="type-body text-muted">Unarchived sessions by stage.</p>
      ) : null}
    </div>
  );
}
