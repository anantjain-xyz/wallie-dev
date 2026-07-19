import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import type { SessionListPageData } from "@/features/sessions/list/data";
import { SessionsPage } from "@/features/sessions/list/sessions-page";
import type { SessionSummary } from "@/features/sessions/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

function makeSession(index: number): SessionSummary {
  const padded = String(index).padStart(3, "0");
  return {
    archivedAt: null,
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
    queryState: { cursor: null, query: "", scope: "all", sort: "updated", stageSlug: null },
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
    expect(paginated).toContain("Load older sessions");
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
              scope: "all",
              sort: "oldest",
              stageSlug: null,
            },
          },
        }),
      ),
    );
    expect(paginatedOldest).toContain("Load newer sessions");
    expect(paginatedOldest).toContain("sort=oldest");
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
    expect(html).toContain('href="/w/acme/sessions/1"');
    expect(html).toContain('href="/w/acme/sessions/50"');
    expect(html).not.toContain("absolute inset-0");
    expect(html).toContain("sessions-ledger-header");
    expect(html).toContain('role="table"');
    expect(html).toContain('role="columnheader"');
    expect(html).toContain("sessions-ledger-cell-label");
    expect(html).toContain(">Repository<");
    expect(html).not.toContain('aria-hidden="true" class="sessions-ledger-header"');
  });

  it("hydrates command bar and row islands instead of a monolithic page client", () => {
    const listDir = join(process.cwd(), "src/features/sessions/list");
    const pageSource = readFileSync(join(listDir, "sessions-page.tsx"), "utf8");
    const commandBarSource = readFileSync(join(listDir, "sessions-command-bar.tsx"), "utf8");
    const rowIslandSource = readFileSync(join(listDir, "session-row-actions.tsx"), "utf8");
    const rowShellSource = readFileSync(join(listDir, "session-ledger-row.tsx"), "utf8");
    const legacyClientSource = readFileSync(join(listDir, "sessions-page-client.tsx"), "utf8");

    expect(pageSource).not.toMatch(/^["']use client["']/m);
    expect(commandBarSource).toMatch(/^["']use client["']/m);
    expect(rowIslandSource).toMatch(/^["']use client["']/m);
    expect(legacyClientSource).not.toContain("function SessionRow");
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
    expect(pageSource).toContain("stageFacets={initialData.stageFacets}");
    expect(commandBarSource).not.toContain("initialData.sessions");
    expect(commandBarSource).not.toContain("initialData.onboarding");

    const stylesheet = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(stylesheet).toContain("container-type: inline-size");
    expect(stylesheet).toContain("@container sessions-ledger (max-width: 50rem)");
    expect(stylesheet).toContain(".sessions-ledger-cell-label");
    expect(stylesheet).not.toContain(".sessions-ledger-cell-stage::before");
  });
});
