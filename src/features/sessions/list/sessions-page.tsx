import Link from "next/link";

import { VisibleInteractionBoundary } from "@/components/telemetry/visible-interaction-boundary";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { withFactoryQuery } from "@/features/factories/factory-selection";
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
import { workspaceRunsPath, workspaceSessionsPath } from "@/lib/routes";

type SessionsPageProps = {
  factoryQuery?: string;
  initialData: SessionListPageData;
  initialNow?: string;
  readOnly?: boolean;
  showCreationOnboarding?: boolean;
};

const ISOLATED_RENDER_NOW = "1970-01-01T00:00:00.000Z";

function FilterEmptyState() {
  return (
    <div className="ui-sheet flex flex-col items-center border-dashed px-6 py-16 text-center">
      <p className="text-[14px] font-semibold text-foreground">No matching sessions</p>
      <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted">Adjust filters.</p>
    </div>
  );
}

/**
 * Server Component Sessions ledger. Command bar and per-row action islands are
 * the only hydrated surfaces; row text/metadata/links render on the server.
 */
export function SessionsPage({
  factoryQuery,
  initialData,
  initialNow,
  readOnly = false,
  showCreationOnboarding = true,
}: SessionsPageProps) {
  const renderNow = initialNow ?? ISOLATED_RENDER_NOW;
  const workspaceSlug = initialData.workspace.slug;
  const basePath = workspaceSessionsPath(workspaceSlug);
  const sessions = initialData.sessions;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <VisibleInteractionBoundary action="pipeline_to_sessions" />
      <PageHeader
        actions={
          <Link
            className="ui-button"
            href={withFactoryQuery(workspaceRunsPath(workspaceSlug), factoryQuery)}
          >
            Runs
          </Link>
        }
        className="mb-4 sm:mb-8"
        title="Sessions"
      />

      <SessionsCommandBar
        key={factoryQuery ?? ""}
        factoryQuery={factoryQuery}
        queryState={initialData.queryState}
        scopeFacets={initialData.scopeFacets}
        stageFacets={initialData.stageFacets}
        workspaceSlug={workspaceSlug}
      />

      {sessions.length === 0 ? (
        !initialData.hasAnySession && showCreationOnboarding ? (
          <SessionsZeroState
            onboarding={initialData.onboarding}
            workspaceSlug={workspaceSlug}
            newSessionHref={withFactoryQuery(
              workspaceSessionsPath(workspaceSlug, { create: 1 }),
              factoryQuery,
            )}
          />
        ) : (
          <FilterEmptyState />
        )
      ) : (
        <SessionsLedgerVisibilityProvider
          emptyFallback={<FilterEmptyState />}
          key={[
            factoryQuery ?? "",
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
                readOnly={readOnly}
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
            href={withFactoryQuery(
              buildSessionsListHref(basePath, {
                ...initialData.queryState,
                cursor: initialData.nextCursor,
              }),
              factoryQuery,
            )}
          >
            {sessionsPaginationLabel(initialData.queryState.sort)}
          </Link>
        </div>
      ) : null}
    </PageContainer>
  );
}
