import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionListPageData } from "@/features/sessions/list/data";
import type { SessionSummary } from "@/features/sessions/types";

const router = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import {
  getSessionTitleEditKeyIntent,
  SessionsPageClient,
} from "@/features/sessions/list/sessions-page-client";

const baseSession = {
  archivedAt: null,
  createdAt: "2026-06-07T10:00:00.000Z",
  currentArtifactVersion: null,
  currentStageId: "stage-product",
  currentStageName: "Product",
  currentStageSlug: "product",
  id: "11111111-1111-4111-8111-111111111111",
  linearIssueId: "WAL-42",
  linearIssueUrl: "https://linear.app/wallie/issue/WAL-42/session-title",
  number: 42,
  phaseStatus: "agent_generating",
  pipelineId: "pipeline-1",
  promptMd: "Make session titles editable from sessions page.",
  pullRequestCount: 0,
  pullRequests: [],
  rejectionCount: 0,
  title: "Make session titles editable",
  updatedAt: "2026-06-07T11:00:00.000Z",
  workspaceId: "22222222-2222-4222-8222-222222222222",
} satisfies SessionSummary;

function pageData(sessions: SessionSummary[] = [baseSession]): SessionListPageData {
  return {
    onboarding: null,
    queryState: {
      query: "",
      scope: "all",
      stageSlug: null,
    },
    sessions,
    totalCount: sessions.length,
    workspace: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Wallie",
      slug: "wallie",
    },
  };
}

describe("SessionsPageClient", () => {
  it("renders accessible per-row title edit controls without removing row navigation", () => {
    const html = renderToStaticMarkup(
      createElement(SessionsPageClient, {
        initialData: pageData(),
      }),
    );

    expect(html).toContain("Edit title for session #42");
    expect(html).toContain("Open session #42: Make session titles editable");
    expect(html).toContain("/w/wallie/sessions/42");
    expect(html).toContain("WAL-42");
  });

  it("maps keyboard shortcuts for title editing", () => {
    expect(getSessionTitleEditKeyIntent("Enter")).toBe("save");
    expect(getSessionTitleEditKeyIntent("Escape")).toBe("cancel");
    expect(getSessionTitleEditKeyIntent("Tab")).toBeNull();
  });
});
