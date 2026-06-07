import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SessionsPageClient } from "@/features/sessions/list/sessions-page-client";
import type { SessionListPageData } from "@/features/sessions/list/data";

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

function makeSessionListData(): SessionListPageData {
  return {
    onboarding: null,
    queryState: {
      query: "",
      scope: "all",
      stageSlug: null,
    },
    sessions: [
      {
        archivedAt: null,
        createdAt: "2026-06-07T10:00:00.000Z",
        currentArtifactVersion: 1,
        currentStageId: "stage-1",
        currentStageName: "Product",
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
      },
    ],
    totalCount: 1,
    workspace: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Acme",
      slug: "acme",
    },
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
});
