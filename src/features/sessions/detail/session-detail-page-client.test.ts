import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  centerStageRailSelection,
  reconcilePhaseMutationResult,
  SessionDetailPageClient,
} from "@/features/sessions/detail/session-detail-page-client";
import type { SessionReviewData } from "@/features/sessions/detail/data";

const mocked = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mocked.refresh,
  }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    channel: () => ({
      on: function on() {
        return this;
      },
      subscribe: () => undefined,
    }),
    removeChannel: vi.fn(),
  }),
}));

vi.mock("@/features/wallie/session-wallie-panel", () => ({
  SessionWalliePanel: () => null,
}));

function makeSessionDetailData(): SessionReviewData {
  return {
    creatorDisplayName: null,
    session: {
      archivedAt: null,
      artifacts: [],
      createdAt: "2026-06-07T10:00:00.000Z",
      currentArtifactVersion: 1,
      currentStageId: "stage-1",
      currentStageSlug: "product",
      id: "11111111-1111-4111-8111-111111111111",
      linearIssueId: null,
      linearIssueUrl: null,
      number: 7,
      phaseCompletions: [],
      phaseStatus: "awaiting_review",
      pipeline: {
        stages: [
          {
            description: "Define the product",
            id: "stage-1",
            name: "Product",
            position: 0,
            slug: "product",
          },
        ],
      },
      promptMd: "Build the title editor",
      pullRequests: [],
      title: "Editable Session",
      updatedAt: "2026-06-07T11:00:00.000Z",
    },
    workspaceSlug: "acme",
  };
}

function renderDetail(
  overrides: {
    activity?: ReactNode;
    canReview?: boolean;
    data?: SessionReviewData;
    initialFormattedArtifact?: ReactNode | null;
    initialFormattedArtifactKey?: string | null;
  } = {},
) {
  return renderToStaticMarkup(
    createElement(SessionDetailPageClient, {
      activity: overrides.activity ?? null,
      canReview: overrides.canReview ?? true,
      initialData: overrides.data ?? makeSessionDetailData(),
      initialFormattedArtifact: overrides.initialFormattedArtifact ?? null,
      initialFormattedArtifactKey: overrides.initialFormattedArtifactKey ?? null,
      repository: {
        defaultBranch: "main",
        fullName: "acme/app",
        htmlUrl: "https://github.com/acme/app",
      },
    }),
  );
}

describe("SessionDetailPageClient", () => {
  it("centers the selected stage with horizontal rail scrolling only", () => {
    const scrollTo = vi.fn();
    const rail = {
      clientWidth: 320,
      scrollTo,
      scrollWidth: 900,
    } as unknown as HTMLOListElement;
    const selectedButton = {
      offsetLeft: 480,
      offsetWidth: 120,
    } as HTMLButtonElement;

    centerStageRailSelection(rail, selectedButton);

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", left: 380 });
  });

  it("merges an authoritative stage snapshot that was absent from the initial pipeline", () => {
    const data = makeSessionDetailData();

    const next = reconcilePhaseMutationResult(data.session, {
      archivedAt: null,
      artifactVersion: 0,
      currentStage: {
        description: "A stage added while the detail page was open",
        id: "stage-2",
        name: "Build",
        position: 1,
        slug: "build",
      },
      currentStageId: "stage-2",
      id: data.session.id,
      phaseStatus: "agent_generating",
      rejectionCount: 0,
      updatedAt: "2026-06-07T12:00:00.000Z",
    });

    expect(next.currentStageId).toBe("stage-2");
    expect(next.currentStageSlug).toBe("build");
    expect(next.pipeline.stages).toContainEqual(
      expect.objectContaining({ id: "stage-2", slug: "build" }),
    );
  });

  it("renders an accessible title edit affordance alongside the session title", () => {
    const html = renderDetail();

    expect(html).toContain("Editable Session");
    expect(html).toContain('aria-label="Edit title for session #7"');
    expect(html).not.toContain('title="Edit title"');
    expect(html).not.toContain('aria-label="Session #7 title"');
  });

  it("keeps the edit control outside the heading so the heading name is only the title", () => {
    const html = renderDetail();
    const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);

    expect(headingMatch).not.toBeNull();
    expect(headingMatch?.[1]).toBe("Editable Session");
  });

  it("folds the session number into the breadcrumb instead of an orphaned row", () => {
    const html = renderDetail();
    const breadcrumbMatch = html.match(/← Sessions[\s\S]*?#7/);
    expect(breadcrumbMatch).not.toBeNull();
    expect(html).not.toMatch(/<span class="font-mono">#7<\/span>/);
  });

  it("renders creator and created time in the Context inspector", () => {
    const data = makeSessionDetailData();
    data.creatorDisplayName = "Ada Lovelace";
    const html = renderDetail({ data });

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Created");
    expect(html).toContain('dateTime="2026-06-07T10:00:00.000Z"');
    expect(html).toContain(">2026-06-07 10:00 UTC</time>");
    expect(html).toContain("Run input");
    expect(html).toContain("acme/app");
  });

  it("uses a 70/30 workbench grid with sticky review controls", () => {
    const html = renderDetail();

    expect(html).toContain("lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)]");
    expect(html).toContain("sticky bottom-0");
    expect(html).toContain("Request changes");
    expect(html).toContain("Approve &amp; archive");
    expect(html).toContain('aria-label="Pipeline stages"');
    expect(html).not.toContain("max-h-[480px]");
    expect(html).not.toContain(">Prompt<");
  });

  it("keeps the review surface rendered when activity is deferred", () => {
    const data = makeSessionDetailData();
    data.session.artifacts = [
      {
        createdAt: "2026-06-07T10:30:00.000Z",
        payload: "# Rendered artifact",
        stageSlug: "product",
        version: 1,
      },
    ];
    const html = renderDetail({
      activity: createElement("div", null, "Run activity is temporarily unavailable"),
      data,
      initialFormattedArtifact: createElement("article", null, "Rendered artifact"),
      initialFormattedArtifactKey: "11111111-1111-4111-8111-111111111111:product:1",
    });

    expect(html).toContain("Editable Session");
    expect(html).toContain("Product artifact");
    expect(html).toContain("Rendered artifact");
    expect(html).toContain("Request changes");
    expect(html).toContain("Approve &amp; archive");
  });

  it("shows reviewable controls when awaiting review", () => {
    const html = renderDetail();
    expect(html).toContain("Request changes");
    expect(html).toContain("Approve &amp; archive");
  });

  it("shows stop run while generating", () => {
    const data = makeSessionDetailData();
    data.session.phaseStatus = "agent_generating";
    const html = renderDetail({ data });
    expect(html).toContain("Stop run");
    expect(html).not.toContain("Request changes");
  });

  it("shows an explicit completed reason", () => {
    const data = makeSessionDetailData();
    data.session.phaseStatus = "approved";
    const html = renderDetail({ data });
    expect(html).toContain("This session is complete.");
    expect(html).not.toContain("Request changes");
  });

  it("shows an explicit archived reason", () => {
    const data = makeSessionDetailData();
    data.session.archivedAt = "2026-07-01T00:00:00.000Z";
    const html = renderDetail({ data });
    expect(html).toContain("This session is archived.");
    expect(html).not.toContain("Request changes");
  });

  it("keeps Request changes when the viewer cannot approve", () => {
    const html = renderDetail({ canReview: false });
    expect(html).toContain("Request changes");
    expect(html).toContain("You are not authorized to approve this stage.");
    expect(html).not.toContain("Approve &amp; archive");
  });

  it("shows an explicit read-only reason when the stage is not ready for review", () => {
    const data = makeSessionDetailData();
    data.session.phaseStatus = "rejected";
    const html = renderDetail({ data });
    expect(html).toContain("This stage is not ready for review.");
    expect(html).not.toContain("Request changes");
  });

  it("keeps Run input collapsed by default in Context", () => {
    const html = renderDetail();
    expect(html).toContain("Run input");
    expect(html).toContain("Collapsed — expand to inspect");
    expect(html).not.toContain("Build the title editor");
  });
});
