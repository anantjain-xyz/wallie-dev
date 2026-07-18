import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  commitListArchive,
  commitListTitle,
  SessionsPageClient,
} from "@/features/sessions/list/sessions-page-client";
import type { SessionListPageData, SessionStageFacet } from "@/features/sessions/list/data";
import type { SessionSummary } from "@/features/sessions/types";

const mocked = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mocked.refresh,
    replace: mocked.replace,
  }),
}));

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    archivedAt: null,
    createdAt: "2026-06-07T10:00:00.000Z",
    currentArtifactVersion: 1,
    currentStageId: "stage-1",
    currentStageName: "Product",
    currentStagePosition: 0,
    currentStageSlug: "product",
    id: "11111111-1111-4111-8111-111111111111",
    linearIssueId: null,
    linearIssueUrl: null,
    number: 7,
    phaseStatus: "awaiting_review",
    pipelineId: "pipeline-1",
    promptMd: "Build the title editor",
    pullRequestCount: 0,
    pullRequests: [],
    rejectionCount: 0,
    title: "Editable Session",
    updatedAt: "2026-06-07T11:00:00.000Z",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

function makeStageFacets(sessions: SessionSummary[]): SessionStageFacet[] {
  const facets = new Map<string, SessionStageFacet>();
  for (const session of sessions) {
    const facet = facets.get(session.currentStageSlug);
    if (facet) {
      facet.count += 1;
      continue;
    }

    facets.set(session.currentStageSlug, {
      count: 1,
      name: session.currentStageName,
      position: session.currentStagePosition,
      slug: session.currentStageSlug,
    });
  }

  return [...facets.values()];
}

function makeSessionListData(
  sessions: SessionSummary[] = [makeSession()],
  overrides: Partial<SessionListPageData> = {},
): SessionListPageData {
  return {
    hasAnySession: sessions.length > 0,
    hasMore: false,
    nextCursor: null,
    onboarding: null,
    queryState: {
      cursor: null,
      query: "",
      scope: "all",
      stageSlug: null,
    },
    sessions,
    stageFacets: makeStageFacets(sessions),
    totalCount: sessions.length,
    workspace: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Acme",
      slug: "acme",
    },
    ...overrides,
  };
}

describe("SessionsPageClient", () => {
  it("renders an accessible title edit affordance without removing row navigation", () => {
    const html = renderToStaticMarkup(
      createElement(SessionsPageClient, {
        initialData: makeSessionListData(),
      }),
    );

    expect(html).toContain('href="/w/acme/sessions/7"');
    expect(html).toContain("Open session #7: Editable Session");
    expect(html).toContain('aria-label="Edit title for session #7"');
    expect(html).toContain('title="Edit title"');
    expect(html).not.toContain('aria-label="Session #7 title"');
  });

  it("orders stage filter chips by pipeline position, not session arrival order", () => {
    // Sessions arrive ordered by updated_at (build is most recent), but the
    // chips must follow pipeline position: plan → build → review → land.
    const sessions: SessionSummary[] = [
      makeSession({
        id: "11111111-1111-4111-8111-111111111111",
        number: 1,
        currentStageId: "stage-build",
        currentStageName: "Build",
        currentStagePosition: 1,
        currentStageSlug: "build",
      }),
      makeSession({
        id: "22222222-2222-4222-8222-222222222222",
        number: 2,
        currentStageId: "stage-land",
        currentStageName: "Land",
        currentStagePosition: 3,
        currentStageSlug: "land",
      }),
      makeSession({
        id: "33333333-3333-4333-8333-333333333333",
        number: 3,
        currentStageId: "stage-plan",
        currentStageName: "Plan",
        currentStagePosition: 0,
        currentStageSlug: "plan",
      }),
      makeSession({
        id: "44444444-4444-4444-8444-444444444444",
        number: 4,
        currentStageId: "stage-review",
        currentStageName: "Review",
        currentStagePosition: 2,
        currentStageSlug: "review",
      }),
    ];

    const html = renderToStaticMarkup(
      createElement(SessionsPageClient, {
        initialData: makeSessionListData(sessions),
      }),
    );

    const order = ["Plan", "Build", "Review", "Land"].map((name) => html.indexOf(`>${name}`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("renders stage filters from facets independent of the current page rows", () => {
    const html = renderToStaticMarkup(
      createElement(SessionsPageClient, {
        initialData: makeSessionListData(
          [
            makeSession({
              currentStageName: "Build",
              currentStagePosition: 1,
              currentStageSlug: "build",
              number: 1,
            }),
          ],
          {
            stageFacets: [
              { count: 12, name: "Plan", position: 0, slug: "plan" },
              { count: 1, name: "Build", position: 1, slug: "build" },
              { count: 4, name: "Land", position: 3, slug: "land" },
            ],
          },
        ),
      }),
    );

    expect(html).toContain(">Plan");
    expect(html).toContain(">Land");
    expect(html).toContain(">12</span>");
    expect(html).toContain(">4</span>");
  });
});

describe("session list mutation reconciliation", () => {
  it("uses the title response timestamp and moves the updated row to the top", () => {
    const older = makeSession({
      id: "older",
      number: 1,
      updatedAt: "2026-06-07T10:00:00.000Z",
    });
    const newer = makeSession({
      id: "newer",
      number: 2,
      updatedAt: "2026-06-07T11:00:00.000Z",
    });

    const result = commitListTitle([newer, older], {
      id: older.id,
      title: "Updated title",
      updatedAt: "2026-06-07T12:00:00.000Z",
    });

    expect(result.map((session) => session.id)).toEqual(["older", "newer"]);
    expect(result[0]).toMatchObject({
      title: "Updated title",
      updatedAt: "2026-06-07T12:00:00.000Z",
    });
  });

  it("does not replay a stale committed title over newer server data", () => {
    const fresh = makeSession({
      title: "Newer server title",
      updatedAt: "2026-06-07T13:00:00.000Z",
    });

    expect(
      commitListTitle([fresh], {
        id: fresh.id,
        title: "Older committed title",
        updatedAt: "2026-06-07T12:00:00.000Z",
      }),
    ).toEqual([fresh]);
  });

  it("removes archive changes that no longer match the server-backed scope", () => {
    const active = makeSession({ id: "active" });
    const archived = makeSession({ archivedAt: "2026-06-07T09:00:00.000Z", id: "archived" });

    expect(
      commitListArchive([active], "active", {
        archivedAt: "2026-06-07T12:00:00.000Z",
        id: active.id,
        phaseStatus: active.phaseStatus,
        updatedAt: "2026-06-07T12:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      commitListArchive([archived], "archived", {
        archivedAt: null,
        id: archived.id,
        phaseStatus: archived.phaseStatus,
        updatedAt: "2026-06-07T12:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("uses authoritative archive timestamps without regressing fresher rows", () => {
    const stale = makeSession({
      archivedAt: null,
      id: "stale",
      updatedAt: "2026-06-07T10:00:00.000Z",
    });
    const fresh = makeSession({
      archivedAt: null,
      id: "fresh",
      updatedAt: "2026-06-07T13:00:00.000Z",
    });

    const result = commitListArchive([fresh, stale], "all", {
      archivedAt: "2026-06-07T12:00:00.000Z",
      id: stale.id,
      phaseStatus: "rejected",
      updatedAt: "2026-06-07T12:00:00.000Z",
    });
    expect(result.map((session) => session.id)).toEqual(["fresh", "stale"]);
    expect(result[1]).toMatchObject({
      archivedAt: "2026-06-07T12:00:00.000Z",
      phaseStatus: "rejected",
      updatedAt: "2026-06-07T12:00:00.000Z",
    });

    expect(
      commitListArchive([fresh], "all", {
        archivedAt: "2026-06-07T12:00:00.000Z",
        id: fresh.id,
        phaseStatus: "rejected",
        updatedAt: "2026-06-07T12:00:00.000Z",
      }),
    ).toEqual([fresh]);
  });
});
