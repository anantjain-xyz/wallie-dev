import Link from "next/link";
import type { ReactNode } from "react";

import type { SessionReviewRepository, SessionReviewSession } from "./data";
import { SessionInspector } from "./session-inspector";
import { workspaceSessionDetailPath, workspaceSessionsPath } from "@/lib/routes";
import type { WorkflowInspectionHeader } from "@/lib/factory-workflows/inspection-contracts";

export function SessionDetailHeader({
  actions,
  creatorDisplayName,
  initialNow,
  repository,
  session,
  title,
  workspaceSlug,
  workflowInspection,
}: {
  actions: ReactNode;
  creatorDisplayName: string | null;
  initialNow: string;
  repository: SessionReviewRepository | null;
  session: SessionReviewSession;
  title: ReactNode;
  workspaceSlug: string;
  workflowInspection?: WorkflowInspectionHeader;
}) {
  const monitoring = session.monitoring;
  return (
    <header className="mb-6 min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-muted">
          <Link href={workspaceSessionsPath(workspaceSlug)} className="hover:text-foreground">
            ← Sessions
          </Link>
          <span aria-hidden="true">/</span>
          <span className="font-mono">#{session.number}</span>
        </nav>
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
            Sentry issue {monitoring.sentryIssueId} in {monitoring.environment}
          </summary>
          <dl className="mt-2 space-y-1 text-xs text-muted">
            <div>
              <dt className="inline font-medium">Source session </dt>
              <dd className="inline">
                <Link
                  className="text-accent hover:underline"
                  href={workspaceSessionDetailPath(workspaceSlug, monitoring.sourceSessionNumber)}
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
              <dt className="inline font-medium">Sentry event </dt>
              <dd className="inline font-mono [overflow-wrap:anywhere]">
                {monitoring.sentryEventId}
              </dd>
            </div>
          </dl>
        </details>
      ) : null}
    </header>
  );
}
