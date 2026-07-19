import { TimeDisplay } from "@/components/shared/time-display";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import { SessionRowIsland } from "@/features/sessions/list/session-row-actions";
import type { SessionFilterKey, SessionListItem } from "@/features/sessions/types";
import { workspaceSessionDetailPath } from "@/lib/routes";

type SessionLedgerRowProps = {
  initialNow: string;
  scope: SessionFilterKey;
  session: SessionListItem;
  workspaceSlug: string;
};

/**
 * Server Component row shell. Static metadata and connection links render on the
 * server; the title/overflow/archive island hydrates independently.
 */
export function SessionLedgerRow({
  initialNow,
  scope,
  session,
  workspaceSlug,
}: SessionLedgerRowProps) {
  const detailHref = workspaceSessionDetailPath(workspaceSlug, session.number);

  return (
    <SessionRowIsland
      connections={
        <SessionConnections
          compact
          linearIssueId={session.linearIssueId}
          linearIssueUrl={session.linearIssueUrl}
          pullRequests={session.pullRequests}
        />
      }
      detailHref={detailHref}
      metaTrailing={
        <>
          <span>·</span>
          <span>
            updated{" "}
            <TimeDisplay initialNow={initialNow} value={session.updatedAt} variant="relative" />
          </span>
        </>
      }
      scope={scope}
      session={{
        archivedAt: session.archivedAt,
        id: session.id,
        number: session.number,
        phaseStatus: session.phaseStatus,
        title: session.title,
        updatedAt: session.updatedAt,
      }}
      stageName={session.currentStageName}
    />
  );
}
