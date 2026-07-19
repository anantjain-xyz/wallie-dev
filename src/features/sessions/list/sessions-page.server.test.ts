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
    title: `Session ${index}`,
    updatedAt: `2026-06-07T11:${String(index % 60).padStart(2, "0")}:00.000Z`,
    workspaceId: "22222222-2222-4222-8222-222222222222",
  };
}

function makeData(count: number): SessionListPageData {
  const sessions = Array.from({ length: count }, (_, index) => makeSession(index + 1));
  return {
    hasAnySession: true,
    hasMore: false,
    nextCursor: null,
    onboarding: null,
    queryState: { cursor: null, query: "", scope: "all", stageSlug: null },
    sessions,
    stageFacets: [{ count, name: "Plan", position: 0, slug: "plan" }],
    totalCount: count,
    workspace: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Acme",
      slug: "acme",
    },
  };
}

describe("Sessions ledger server render", () => {
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
    expect(rowIslandSource).toContain("router.refresh()");
    expect(rowShellSource).toContain('variant="relative"');
    expect(rowShellSource).toContain("TimeDisplay");
  });
});
