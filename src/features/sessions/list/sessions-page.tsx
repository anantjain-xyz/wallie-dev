import Link from "next/link";
import type { ReactNode } from "react";

import { VisibleInteractionBoundary } from "@/components/telemetry/visible-interaction-boundary";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { withFactoryQuery } from "@/features/factories/factory-selection";
import { SessionsViewTitle } from "@/features/sessions/components/sessions-view-navigation";
import { SessionsZeroState } from "@/features/sessions/components/sessions-zero-state";
import type { SessionListPageData } from "@/features/sessions/list/data";
import { SessionsCommandBar } from "@/features/sessions/list/sessions-command-bar";
import { SessionLedgerRow } from "@/features/sessions/list/session-ledger-row";
import { SessionsLedger } from "@/features/sessions/list/session-row-actions";
import { SessionsLedgerVisibilityProvider } from "@/features/sessions/list/sessions-ledger-visibility";
import {
  buildSessionsListHref,
  sessionsPaginationDirection,
} from "@/features/sessions/list/sessions-list-mutations";
import { SESSION_LIST_DEFAULT_SORT } from "@/features/sessions/list/sessions-list-query-state";
import type { SessionFilterKey, SessionListQueryState } from "@/features/sessions/types";
import { workspaceRunsPath, workspaceSessionsPath } from "@/lib/routes";

type SessionsPageProps = {
  factoryId?: string;
  factoryName?: string;
  factoryQuery?: string;
  factorySelector?: ReactNode;
  initialData: SessionListPageData;
  initialNow?: string;
  readOnly?: boolean;
  showCreationOnboarding?: boolean;
};

const ISOLATED_RENDER_NOW = "1970-01-01T00:00:00.000Z";

type SessionsEmptyResolution =
  | { kind: "paged-out" }
  | { kind: "filtered" }
  | { kind: "first-run" }
  | { kind: "slice-empty"; scope: "active" | "archived" }
  | { kind: "scope-empty"; aggregate: boolean };

function resolveSessionsEmptyState(input: {
  hasAnySession: boolean;
  queryState: SessionListQueryState;
  showCreationOnboarding: boolean;
  aggregate: boolean;
}): SessionsEmptyResolution {
  const { aggregate, hasAnySession, queryState, showCreationOnboarding } = input;
  if (queryState.cursor) return { kind: "paged-out" };
  if (queryState.query.trim() || queryState.stageSlug || queryState.status)
    return { kind: "filtered" };
  if (!hasAnySession) {
    return showCreationOnboarding ? { kind: "first-run" } : { kind: "scope-empty", aggregate };
  }
  if (queryState.scope === "active" || queryState.scope === "archived") {
    return { kind: "slice-empty", scope: queryState.scope };
  }
  return { kind: "scope-empty", aggregate };
}

function SessionsEmptyPanel({
  action,
  body,
  title,
}: {
  action?: ReactNode;
  body: string;
  title: string;
}) {
  return (
    <div className="ui-sheet flex flex-col items-center border-dashed px-6 py-16 text-center">
      <p className="text-[14px] font-semibold text-foreground">{title}</p>
      <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted">{body}</p>
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * The stored-filter cookie only yields to an explicit scope/stage/sort param,
 * so empty-state links always pin `scope` even when it is the default value.
 */
function withExplicitScope(href: string, scope: SessionFilterKey) {
  const url = new URL(href, "http://localhost");
  url.searchParams.set("scope", scope);
  return `${url.pathname}${url.search}`;
}

/**
 * Server Component Sessions ledger. Command bar and per-row action islands are
 * the only hydrated surfaces; row text/metadata/links render on the server.
 */
export function SessionsPage({
  factoryId,
  factoryName,
  factoryQuery,
  factorySelector,
  initialData,
  initialNow,
  readOnly = false,
  showCreationOnboarding = true,
}: SessionsPageProps) {
  const renderNow = initialNow ?? ISOLATED_RENDER_NOW;
  const workspaceSlug = initialData.workspace.slug;
  const basePath = workspaceSessionsPath(workspaceSlug);
  const sessions = initialData.sessions;
  const { queryState } = initialData;
  const aggregateScope = factoryQuery === "all";

  function listHref(state: SessionListQueryState, factory = factoryQuery ?? factoryId) {
    return withFactoryQuery(
      withExplicitScope(buildSessionsListHref(basePath, state), state.scope),
      factory,
    );
  }

  const returnTo = listHref(queryState);
  const firstPageHref = listHref({ ...queryState, cursor: null });
  const clearFiltersScope = queryState.scope === "all" ? "all" : "active";
  const clearFiltersHref =
    clearFiltersScope === "all" || queryState.sort !== SESSION_LIST_DEFAULT_SORT
      ? listHref({
          cursor: null,
          query: "",
          scope: clearFiltersScope,
          sort: queryState.sort,
          stageSlug: null,
        })
      : null;
  const viewAllHref = listHref({
    cursor: null,
    query: "",
    scope: "all",
    sort: queryState.sort,
    stageSlug: null,
  });
  const acrossFactoriesHref = workspaceSessionsPath(workspaceSlug, { factory: "all" });
  const canWiden =
    !aggregateScope || queryState.scope !== "all" || queryState.stageSlug || queryState.status;
  const widenedSearchHref = listHref(
    { ...queryState, cursor: null, scope: "all", stageSlug: null, status: undefined },
    "all",
  );

  // A locally hidden last row is not an empty result set: later pages and other
  // slices can still hold sessions, so the fallback stays page-local.
  function renderLocalEmpty(): ReactNode {
    const action = queryState.cursor ? (
      <Link className="ui-button" href={firstPageHref}>
        Back to first page
      </Link>
    ) : queryState.scope === "active" || queryState.scope === "archived" ? (
      <Link className="ui-button" href={viewAllHref}>
        View all sessions
      </Link>
    ) : null;
    return (
      <SessionsEmptyPanel
        action={action ?? undefined}
        body="Refresh the list or change filters to see more sessions."
        title="No sessions on this page"
      />
    );
  }

  function renderListEmpty(hasAnySession: boolean): ReactNode {
    const resolution = resolveSessionsEmptyState({
      aggregate: aggregateScope,
      hasAnySession,
      queryState,
      showCreationOnboarding,
    });

    switch (resolution.kind) {
      case "paged-out":
        return (
          <SessionsEmptyPanel
            action={
              <Link className="ui-button" href={firstPageHref}>
                Back to first page
              </Link>
            }
            body="This page is empty. Return to the first page to keep browsing."
            title="No more sessions on this page"
          />
        );
      case "filtered":
        return (
          <SessionsEmptyPanel
            action={
              <>
                {canWiden ? (
                  <Link className="ui-button" href={widenedSearchHref}>
                    Search all sessions in accessible factories
                  </Link>
                ) : null}
                {clearFiltersHref ? (
                  <Link className="ui-button" href={clearFiltersHref}>
                    {queryState.scope === "archived"
                      ? "Show unfiltered, unarchived sessions"
                      : "Show unfiltered sessions"}
                  </Link>
                ) : null}
              </>
            }
            body="No sessions match the search and filters in this scope."
            title="No matching sessions"
          />
        );
      case "first-run":
        return (
          <SessionsZeroState
            onboarding={initialData.onboarding}
            workspaceSlug={workspaceSlug}
            newSessionHref={withFactoryQuery(
              workspaceSessionsPath(workspaceSlug, { create: 1 }),
              factoryQuery,
            )}
          />
        );
      case "slice-empty":
        return (
          <SessionsEmptyPanel
            action={
              <Link className="ui-button" href={viewAllHref}>
                View all sessions
              </Link>
            }
            body={
              resolution.scope === "active"
                ? "All sessions are archived."
                : "No sessions are archived."
            }
            title={
              resolution.scope === "active" ? "No unarchived sessions" : "No archived sessions"
            }
          />
        );
      case "scope-empty":
        return resolution.aggregate ? (
          <SessionsEmptyPanel
            body="No sessions across accessible factories yet."
            title="No sessions yet"
          />
        ) : (
          <SessionsEmptyPanel
            action={
              <Link className="ui-button" href={acrossFactoriesHref}>
                View sessions across factories
              </Link>
            }
            body="No sessions in this factory yet."
            title="No sessions yet"
          />
        );
    }
  }

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <VisibleInteractionBoundary action="pipeline_to_sessions" />
      <PageHeader
        actions={
          <>
            {factorySelector}
            <Link
              className="ui-button"
              href={withFactoryQuery(workspaceRunsPath(workspaceSlug), factoryQuery)}
            >
              Runs
            </Link>
          </>
        }
        actionsRightOnDesktop
        className="mb-4 sm:mb-8"
        title={
          <SessionsViewTitle
            factory={factoryQuery ?? factoryId ?? "all"}
            status={queryState.scope === "active" ? queryState.status : undefined}
            view="list"
            workspaceSlug={workspaceSlug}
          />
        }
        titleAsChild
      />

      <SessionsCommandBar
        key={factoryQuery ?? ""}
        factoryName={factoryName}
        factoryQuery={factoryQuery}
        queryState={initialData.queryState}
        scopeFacets={initialData.scopeFacets}
        stageFacets={initialData.stageFacets}
        workspaceSlug={workspaceSlug}
      />

      {sessions.length === 0 ? (
        renderListEmpty(initialData.hasAnySession)
      ) : (
        <SessionsLedgerVisibilityProvider
          emptyFallback={renderLocalEmpty()}
          key={[
            factoryQuery ?? "",
            initialData.queryState.scope,
            initialData.queryState.stageSlug ?? "",
            initialData.queryState.status ?? "",
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
                returnTo={returnTo}
                scope={initialData.queryState.scope}
                session={session}
                workspaceSlug={workspaceSlug}
              />
            ))}
          </SessionsLedger>
        </SessionsLedgerVisibilityProvider>
      )}

      {sessions.length > 0 && (queryState.cursor || initialData.nextCursor) ? (
        <nav
          aria-label="Session pages"
          className="mt-4 flex flex-wrap items-center justify-between gap-2"
        >
          <p className="text-xs text-muted">
            {queryState.cursor ? "Later page" : "First page"} · {sessions.length}{" "}
            {sessions.length === 1 ? "session" : "sessions"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {queryState.cursor ? (
              <Link className="ui-button" href={firstPageHref}>
                Back to first page
              </Link>
            ) : null}
            {initialData.hasMore && initialData.nextCursor ? (
              <>
                <Link
                  aria-describedby="sessions-next-page-direction"
                  className="ui-button"
                  href={listHref({ ...queryState, cursor: initialData.nextCursor })}
                >
                  Next page
                </Link>
                <span id="sessions-next-page-direction" className="text-xs text-muted">
                  {sessionsPaginationDirection(queryState.sort)}
                </span>
              </>
            ) : null}
          </div>
        </nav>
      ) : null}
    </PageContainer>
  );
}
