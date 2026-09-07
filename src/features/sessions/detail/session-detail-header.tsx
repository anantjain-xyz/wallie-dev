import Link from "next/link";
import type { ReactNode } from "react";

import type { SessionReviewRepository, SessionReviewSession } from "./data";
import { SessionInspector } from "./session-inspector";
import { workspaceSessionsPath } from "@/lib/routes";

export function SessionDetailHeader({
  actions,
  creatorDisplayName,
  initialNow,
  repository,
  session,
  title,
  workspaceSlug,
}: {
  actions: ReactNode;
  creatorDisplayName: string | null;
  initialNow: string;
  repository: SessionReviewRepository | null;
  session: SessionReviewSession;
  title: ReactNode;
  workspaceSlug: string;
}) {
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
      />
    </header>
  );
}
