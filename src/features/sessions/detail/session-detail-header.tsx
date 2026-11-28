import Link from "next/link";
import type { ReactNode } from "react";

import { BackLink } from "@/components/ui/back-link";
import type { SessionReviewRepository, SessionReviewSession } from "./data";
import { SessionInspector } from "./session-inspector";
import { workspaceSessionDetailPath, workspaceSessionsPath } from "@/lib/routes";
import type { parseSessionBrowseReturn } from "@/lib/sessions/browse-return";
import type { WorkflowInspectionHeader } from "@/lib/factory-workflows/inspection-contracts";

export function SessionDetailHeader({
  actions,
  browseReturn,
  creatorDisplayName,
  factoryName,
  initialNow,
  repository,
  reviewHandoff,
  session,
  title,
  workspaceSlug,
  workflowInspection,
}: {
  actions: ReactNode;
  browseReturn?: ReturnType<typeof parseSessionBrowseReturn>;
  creatorDisplayName: string | null;
  factoryName?: string;
  initialNow: string;
  repository: SessionReviewRepository | null;
  reviewHandoff?: ReactNode;
  session: SessionReviewSession;
  title: ReactNode;
  workspaceSlug: string;
  workflowInspection?: WorkflowInspectionHeader;
}) {
  const monitoring = session.monitoring;
  return (
    <header className="mb-3 min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <nav aria-label="Breadcrumb" className="flex shrink-0 items-center gap-2">
            <BackLink
              href={browseReturn?.href ?? workspaceSessionsPath(workspaceSlug)}
              className="min-h-11 hover:text-foreground sm:min-h-8"
            >
              {browseReturn?.label ?? "Sessions"}
            </BackLink>
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="font-mono">
              #{session.number}
            </span>
          </nav>
          {factoryName ? (
            <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">
              Factory: <span className="font-medium text-foreground">{factoryName}</span>
            </span>
          ) : null}
        </div>
        {actions}
      </div>
      {title}
      <SessionInspector
        creatorDisplayName={creatorDisplayName}
        initialNow={initialNow}
        repository={repository}
        session={session}
        workflowInspection={
          workflowInspection ? { header: workflowInspection, workspaceSlug } : undefined
        }
      />
      {monitoring ? (
        <details className="rounded-lg border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">
            Sentry incident · {monitoring.environment}
          </summary>
          <dl className="mt-2 space-y-1 text-xs text-muted">
            <div>
              <dt className="inline font-medium">Source session </dt>
              <dd className="inline">
                <Link
                  className="text-accent hover:underline"
                  href={workspaceSessionDetailPath(workspaceSlug, monitoring.sourceSessionNumber, {
                    returnTo: browseReturn?.href,
                  })}
                >
                  #{monitoring.sourceSessionNumber}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Deployment </dt>
              <dd className="inline font-mono [overflow-wrap:anywhere]">
                {monitoring.deploymentId}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Deployed revision </dt>
              <dd className="inline font-mono [overflow-wrap:anywhere]">
                {monitoring.sourceRevision}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Sentry issue </dt>
              <dd className="inline font-mono [overflow-wrap:anywhere]">
                {monitoring.sentryIssueId}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Sentry event </dt>
              <dd className="inline font-mono [overflow-wrap:anywhere]">
                {monitoring.sentryEventId}
              </dd>
            </div>
          </dl>
        </details>
      ) : null}
      {reviewHandoff}
    </header>
  );
}
