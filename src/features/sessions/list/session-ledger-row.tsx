import { formatRelativeTimestamp, formatUtcTimestamp } from "@/components/shared/time-format";
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
  const relativeUpdated = formatRelativeTimestamp(session.updatedAt, initialNow);
  const absoluteLabel = formatUtcTimestamp(session.updatedAt);

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
            <time aria-label={absoluteLabel} dateTime={session.updatedAt}>
              {relativeUpdated}
            </time>
          </span>
        </>
      }
      scope={scope}
      session={session}
      stageName={session.currentStageName}
    />
  );
}
