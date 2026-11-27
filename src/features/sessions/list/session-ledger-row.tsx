import { TimeDisplay } from "@/components/shared/time-display";
import { DAY_MS, timestampMs } from "@/components/shared/time-format";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import { SessionLedgerDate } from "@/features/sessions/list/session-ledger-date";
import { SessionRowIsland } from "@/features/sessions/list/session-row-actions";
import type { SessionFilterKey, SessionListItem } from "@/features/sessions/types";
import { workspaceSessionDetailPath } from "@/lib/routes";

type SessionLedgerRowProps = {
  factoryName?: string;
  initialNow: string;
  readOnly?: boolean;
  returnTo?: string;
  scope: SessionFilterKey;
  session: SessionListItem;
  workspaceSlug: string;
};

/**
 * Server Component row shell. Static metadata and connection links render on the
 * server; the title/overflow/archive island hydrates independently.
 */
export function SessionLedgerRow({
  factoryName,
  initialNow,
  readOnly,
  returnTo,
  scope,
  session,
  workspaceSlug,
}: SessionLedgerRowProps) {
  const detailHref = workspaceSessionDetailPath(workspaceSlug, session.number, { returnTo });
  const updatedMs = timestampMs(session.updatedAt);
  const nowMs = timestampMs(initialNow);
  const showDate = updatedMs !== null && nowMs !== null && nowMs - updatedMs >= 7 * DAY_MS;
  const linearIssueId =
    session.linearIssueId &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.linearIssueId)
      ? "Open Linear issue"
      : session.linearIssueId;
  const repositoryLabel =
    session.repositoryFullName ??
    session.pullRequests.find((pullRequest) => pullRequest.repositoryFullName)
      ?.repositoryFullName ??
    null;

  return (
    <SessionRowIsland
      connections={
        <SessionConnections
          compact
          linearIssueId={linearIssueId}
          linearIssueUrl={session.linearIssueUrl}
          pullRequests={session.pullRequests}
        />
      }
      detailHref={detailHref}
      factoryName={factoryName}
      readOnly={readOnly}
      repositoryLabel={repositoryLabel}
      scope={scope}
      session={{
        archivedAt: session.archivedAt,
        id: session.id,
        number: session.number,
        phaseStatus: session.phaseStatus,
        latestRunStatus: session.latestRunStatus,
        title: session.title,
        updatedAt: session.updatedAt,
      }}
      stageName={session.currentStageName}
      updated={
        showDate ? (
          <SessionLedgerDate value={session.updatedAt} />
        ) : (
          <TimeDisplay initialNow={initialNow} value={session.updatedAt} variant="relative" />
        )
      }
    />
  );
}
