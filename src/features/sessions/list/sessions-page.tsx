import Link from "next/link";

import { VisibleInteractionBoundary } from "@/components/telemetry/visible-interaction-boundary";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { SessionsZeroState } from "@/features/sessions/components/sessions-zero-state";
import type { SessionListPageData } from "@/features/sessions/list/data";
import { SessionsCommandBar } from "@/features/sessions/list/sessions-command-bar";
import { SessionLedgerRow } from "@/features/sessions/list/session-ledger-row";
import { SessionsLedger } from "@/features/sessions/list/session-row-actions";
import { SessionsLedgerVisibilityProvider } from "@/features/sessions/list/sessions-ledger-visibility";
import {
  buildSessionsListHref,
  sessionsPaginationLabel,
} from "@/features/sessions/list/sessions-list-mutations";
import { workspaceSessionsPath } from "@/lib/routes";

type SessionsPageProps = {
  initialData: SessionListPageData;
  initialNow?: string;
};

const ISOLATED_RENDER_NOW = "1970-01-01T00:00:00.000Z";

function FilterEmptyState() {
  return (
    <div className="ui-sheet flex flex-col items-center border-dashed px-6 py-16 text-center">
      <p className="text-[14px] font-semibold text-foreground">No sessions match these filters</p>
      <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted">
        Adjust Status, Stage, Sort, or Search to see more sessions.
      </p>
    </div>
  );
}

/**
 * Server Component Sessions ledger. Command bar and per-row action islands are
 * the only hydrated surfaces; row text/metadata/links render on the server.
 */
export function SessionsPage({ initialData, initialNow }: SessionsPageProps) {
  const renderNow = initialNow ?? ISOLATED_RENDER_NOW;
  const workspaceSlug = initialData.workspace.slug;
  const basePath = workspaceSessionsPath(workspaceSlug);
  const sessions = initialData.sessions;

  return (
    <PageContainer>
      <VisibleInteractionBoundary action="pipeline_to_sessions" />
      <PageHeader title="Sessions" />

      <SessionsCommandBar
        queryState={initialData.queryState}
        stageFacets={initialData.stageFacets}
        workspaceSlug={workspaceSlug}
      />

      {sessions.length === 0 ? (
        !initialData.hasAnySession ? (
          <SessionsZeroState
            onboarding={initialData.onboarding}
            workspaceSlug={workspaceSlug}
            newSessionHref={workspaceSessionsPath(workspaceSlug, { create: 1 })}
          />
        ) : (
          <FilterEmptyState />
        )
      ) : (
        <SessionsLedgerVisibilityProvider
          emptyFallback={<FilterEmptyState />}
          key={[
            initialData.queryState.scope,
            initialData.queryState.stageSlug ?? "",
            initialData.queryState.query,
            initialData.queryState.sort,
            initialData.queryState.cursor ?? "",
          ].join("\0")}
          sessionIds={sessions.map((session) => session.id)}
        >
          <SessionsLedger>
            {sessions.map((session) => (
              <SessionLedgerRow
                key={session.id}
                initialNow={renderNow}
                scope={initialData.queryState.scope}
                session={session}
                workspaceSlug={workspaceSlug}
              />
            ))}
          </SessionsLedger>
        </SessionsLedgerVisibilityProvider>
      )}

      {initialData.hasMore && initialData.nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Link
            className="ui-button"
            href={buildSessionsListHref(basePath, {
              ...initialData.queryState,
              cursor: initialData.nextCursor,
            })}
          >
            {sessionsPaginationLabel(initialData.queryState.sort)}
          </Link>
        </div>
      ) : null}
    </PageContainer>
  );
}
