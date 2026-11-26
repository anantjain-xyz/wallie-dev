import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import type { SessionListPageData } from "@/features/sessions/list/data";
import { SessionsPage } from "@/features/sessions/list/sessions-page";
import type { SessionSummary, SessionListItem } from "@/features/sessions/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

function makeSession(index: number): SessionSummary & SessionListItem {
  const padded = String(index).padStart(3, "0");
  return {
    archivedAt: null,
    latestRunStatus: null,
    createdAt: "2026-06-07T10:00:00.000Z",
    currentArtifactVersion: 1,
    currentStageId: "stage-1",
    currentStageName: "Plan",
    currentStagePosition: 0,
    currentStageSlug: "plan",
    id: `11111111-1111-4111-8111-111111111${padded}`,
    linearIssueId: null,
    linearIssueUrl: null,
    number: index,
    phaseStatus: "awaiting_review",
    pipelineId: "pipeline-1",
    promptMd: `Prompt ${index}`,
    pullRequestCount: 0,
    pullRequests: [],
    rejectionCount: 0,
    repositoryFullName: null,
    title: `Session ${index}`,
    updatedAt: `2026-06-07T11:${String(index % 60).padStart(2, "0")}:00.000Z`,
    workspaceId: "22222222-2222-4222-8222-222222222222",
  };
}

function makeData(count: number): SessionListPageData {
  const sessions = Array.from({ length: count }, (_, index) => makeSession(index + 1));
  return {
    hasAnySession: count > 0,
    hasMore: false,
    nextCursor: null,
    onboarding: null,
    queryState: { cursor: null, query: "", scope: "active", sort: "updated", stageSlug: null },
    scopeFacets: { active: count, all: count, archived: 0 },
    sessions,
    stageFacets: count > 0 ? [{ count, name: "Plan", position: 0, slug: "plan" }] : [],
    totalCount: count,
    workspace: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Acme",
      slug: "acme",
    },
  };
}

describe("Sessions ledger server render", () => {
  it("covers zero, one, fifty, and paginated fixtures", () => {
    const zero = renderToStaticMarkup(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPage, { initialData: makeData(0) }),
      ),
    );
    expect(zero).toContain("No sessions yet");

    const archivedOnlyDefault = renderToStaticMarkup(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPage, {
          initialData: { ...makeData(0), hasAnySession: true },
        }),
      ),
    );
    expect(archivedOnlyDefault).toContain("No unarchived sessions");
    expect(archivedOnlyDefault).not.toContain("No sessions yet");
    expect(archivedOnlyDefault).not.toContain("No matching sessions");

    const one = renderToStaticMarkup(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPage, { initialData: makeData(1) }),
      ),
    );
    expect(one.match(/session-list-row/g)?.length).toBe(1);
    expect(one).toContain("Session 1");

    const fifty = renderToStaticMarkup(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPage, { initialData: makeData(50) }),
      ),
    );
    expect(fifty.match(/session-list-row/g)?.length).toBe(50);

    const paginated = renderToStaticMarkup(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPage, {
          initialData: {
            ...makeData(2),
            hasMore: true,
            nextCursor: "cursor-token",
          },
        }),
      ),
    );
    expect(paginated).toContain("Older updates");
    expect(paginated).toContain("Next page");
    expect(paginated).toContain("First page");
    expect(paginated).toContain("cursor=cursor-token");

    const paginatedOldest = renderToStaticMarkup(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPage, {
          initialData: {
            ...makeData(2),
            hasMore: true,
            nextCursor: "cursor-token",
            queryState: {
              cursor: null,
              query: "",
              scope: "active",
              sort: "oldest",
              stageSlug: null,
            },
          },
        }),
      ),
    );
    expect(paginatedOldest).toContain("Newer updates");
    expect(paginatedOldest).toContain("sort=oldest");
  });

  it("shows an absolute calendar date for an old update without adding a focus target", () => {
    const data = makeData(2);
    data.sessions[1].updatedAt = "2026-01-01T11:00:00.000Z";
    const html = renderToStaticMarkup(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPage, { initialData: data, initialNow: "2026-06-07T11:30:00.000Z" }),
      ),
    );
    expect(html).toContain("29m ago");
    expect(html).toContain(">2026-01-01</time>");
    expect(html).toContain('sessions-ledger-title-flow-updated">Updated <time');
    expect(html).not.toContain("157d ago");
  });

  it("keeps static row text in SSR HTML for 50 rows without absolute overlay links", () => {
    const html = renderToStaticMarkup(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPage, { initialData: makeData(50) }),
      ),
    );

    expect(html.match(/session-list-row/g)?.length).toBe(50);
    expect(html).toContain("Session 1");
    expect(html).toContain("Session 50");
    expect(html).toContain('href="/w/acme/sessions/1?returnTo=');
    expect(html).toContain('href="/w/acme/sessions/50?returnTo=');
    expect(html).not.toContain("absolute inset-0");
    expect(html).toContain("sessions-ledger-header");
    expect(html).toContain('role="table"');
    expect(html).toContain('role="columnheader"');
    expect(html).toContain("sessions-ledger-cell-label");
    expect(html).toContain(">Repository<");
    expect(html).not.toContain('aria-hidden="true" class="sessions-ledger-header"');
  });

  it("renders scoped empty states with honest actions and preserved scope", () => {
    const renderPage = (
      initialData: SessionListPageData,
      options: { factoryQuery?: string; showCreationOnboarding?: boolean } = {},
    ) =>
      renderToStaticMarkup(
        createElement(
          OverlayProvider,
          null,
          createElement(SessionsPage, {
            factoryQuery: options.factoryQuery,
            initialData,
            showCreationOnboarding: options.showCreationOnboarding ?? false,
          }),
        ),
      );
    const emptyData = (overrides: Partial<SessionListPageData> = {}) => ({
      ...makeData(0),
      ...overrides,
    });
    const queryState = (overrides: Partial<SessionListPageData["queryState"]>) => ({
      cursor: null,
      query: "",
      scope: "active" as const,
      sort: "updated" as const,
      stageSlug: null,
      ...overrides,
    });

    const pagedOut = renderPage(
      emptyData({
        hasAnySession: true,
        queryState: queryState({
          cursor: "cursor-token",
          query: "deploy",
          scope: "archived",
          sort: "oldest",
          stageSlug: "plan",
        }),
      }),
      { factoryQuery: "factory-9" },
    );
    expect(pagedOut).toContain("No more sessions on this page");
    expect(pagedOut).toContain("Back to first page");
    expect(pagedOut).toContain("q=deploy");
    expect(pagedOut).toContain("scope=archived");
    expect(pagedOut).toContain("stage=plan");
    expect(pagedOut).toContain("sort=oldest");
    expect(pagedOut).toContain("factory=factory-9");
    expect(pagedOut).not.toContain("cursor=cursor-token");

    const filtered = renderPage(
      emptyData({
        hasAnySession: true,
        queryState: queryState({ query: "deploy", stageSlug: "plan" }),
      }),
      { factoryQuery: "factory-9" },
    );
    expect(filtered).toContain("No matching sessions");
    expect(filtered).toContain("Clear filters");
    expect(filtered).toContain("scope=active");
    expect(filtered).toContain("factory=factory-9");
    expect(filtered).toContain("q=deploy");
    expect(filtered).not.toContain("stage=plan");

    const filteredAllScope = renderPage(
      emptyData({
        hasAnySession: true,
        queryState: queryState({ query: "deploy", scope: "all" }),
      }),
    );
    expect(filteredAllScope).toContain("Clear filters");
    expect(filteredAllScope).toContain("scope=all");

    const noSessionsSingle = renderPage(emptyData(), { factoryQuery: "factory-9" });
    expect(noSessionsSingle).toContain("No sessions yet");
    expect(noSessionsSingle).toContain("View sessions across factories");
    expect(noSessionsSingle).toContain('href="/w/acme/sessions?factory=all"');
    expect(noSessionsSingle).not.toContain("New session");

    const noSessionsAggregate = renderPage(emptyData(), { factoryQuery: "all" });
    expect(noSessionsAggregate).toContain("No sessions yet");
    expect(noSessionsAggregate).toContain("across accessible factories");
    expect(noSessionsAggregate).not.toContain("View sessions across factories");
    expect(noSessionsAggregate).not.toContain("New session");

    const archivedSlice = renderPage(
      emptyData({
        hasAnySession: true,
        queryState: queryState({ scope: "archived" }),
      }),
      { factoryQuery: "factory-9" },
    );
    expect(archivedSlice).toContain("No archived sessions");
    expect(archivedSlice).toContain("View all sessions");
    expect(archivedSlice).toContain("scope=all");
    expect(archivedSlice).toContain("factory=factory-9");
    expect(archivedSlice).not.toContain("New session");

    const allSliceEmpty = renderPage(
      emptyData({
        hasAnySession: true,
        queryState: queryState({ scope: "all" }),
      }),
      { factoryQuery: "factory-9" },
    );
    expect(allSliceEmpty).toContain("No sessions yet");
    expect(allSliceEmpty).toContain("View sessions across factories");
    expect(allSliceEmpty).not.toContain("No unarchived sessions");
    expect(allSliceEmpty).not.toContain("New session");
  });

  it("hydrates command bar and row islands instead of a monolithic page client", () => {
    const listDir = join(process.cwd(), "src/features/sessions/list");
    const pageSource = readFileSync(join(listDir, "sessions-page.tsx"), "utf8");
    const commandBarSource = readFileSync(join(listDir, "sessions-command-bar.tsx"), "utf8");
    const rowIslandSource = readFileSync(join(listDir, "session-row-actions.tsx"), "utf8");
    const rowShellSource = readFileSync(join(listDir, "session-ledger-row.tsx"), "utf8");

    expect(pageSource).not.toMatch(/^["']use client["']/m);
    expect(commandBarSource).toMatch(/^["']use client["']/m);
    expect(rowIslandSource).toMatch(/^["']use client["']/m);
    expect(rowIslandSource).not.toContain("previousSessionTitleRef");
    expect(rowIslandSource).toContain("resolveOptimisticTitle");
    expect(rowIslandSource).toContain("resolveOptimisticArchive");
    expect(rowIslandSource).toContain("shouldApplyArchiveResult");
    expect(rowIslandSource).toContain("router.refresh()");
    expect(rowIslandSource).toContain("SessionRowIslandSession");
    expect(rowShellSource).toContain("archivedAt: session.archivedAt");
    expect(rowShellSource).toContain("phaseStatus: session.phaseStatus");
    expect(rowShellSource).not.toMatch(/session=\{session\}/);
    expect(rowShellSource).toContain('variant="relative"');
    expect(rowShellSource).toContain("TimeDisplay");
    expect(pageSource).not.toMatch(/SessionsCommandBar[^>]*initialData=\{initialData\}/);
    expect(pageSource).toContain("queryState={initialData.queryState}");
    expect(pageSource).toContain("scopeFacets={initialData.scopeFacets}");
    expect(pageSource).toContain("stageFacets={initialData.stageFacets}");
    expect(commandBarSource).not.toContain("initialData.sessions");
    expect(commandBarSource).not.toContain("initialData.onboarding");

    const stylesheet = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(stylesheet).toContain("container-type: inline-size");
    expect(stylesheet).toContain("@container sessions-ledger (max-width: 53rem)");
    expect(stylesheet).toContain(".sessions-ledger-cell-label");
    expect(stylesheet).toContain(".sessions-ledger-session-summary");
    expect(stylesheet).toContain(".sessions-ledger-session-title-clip");
    expect(stylesheet).toContain(".sessions-ledger-session-title");
    expect(stylesheet).toContain("max-height: calc(1.375em * 2 - 1px)");
    expect(stylesheet).toContain(".sessions-ledger-title-flow");
    expect(stylesheet).not.toContain(".sessions-ledger-row-archived");
    expect(stylesheet).not.toContain("color-mix(in srgb, var(--control-muted) 55%, transparent)");
    expect(rowIslandSource).not.toContain("sessions-ledger-row-archived");
    expect(stylesheet).toMatch(/\.sessions-ledger-connections,[\s\S]*grid-column: 2/);
    expect(stylesheet).not.toContain(".sessions-ledger-cell-stage::before");
    expect(commandBarSource).not.toContain("sticky top-[");
    expect(rowIslandSource).toContain("sessions-ledger-title-flow");
  });
});
