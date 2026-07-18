import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
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
  createSupabaseBrowserClient: () => ({}),
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

describe("SessionDetailPageClient", () => {
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
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: makeSessionDetailData(),
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    expect(html).toContain("Editable Session");
    expect(html).toContain('aria-label="Edit title for session #7"');
    expect(html).not.toContain('title="Edit title"');
    expect(html).not.toContain('aria-label="Session #7 title"');
  });

  it("keeps the edit control outside the heading so the heading name is only the title", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: makeSessionDetailData(),
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);

    expect(headingMatch).not.toBeNull();
    // The heading must contain only the title text — no nested buttons/controls.
    expect(headingMatch?.[1]).toBe("Editable Session");
  });

  it("folds the session number into the breadcrumb instead of an orphaned row", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: makeSessionDetailData(),
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    // Session number lives next to the "Sessions" breadcrumb link.
    const breadcrumbMatch = html.match(/← Sessions[\s\S]*?#7/);
    expect(breadcrumbMatch).not.toBeNull();
    // No standalone `#7` sitting on its own between title and stage tracker.
    expect(html).not.toMatch(/<span class="font-mono">#7<\/span>/);
  });

  it("renders a metadata row with created and updated times", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: makeSessionDetailData(),
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    expect(html).toContain("Created");
    expect(html).toContain("Updated");
    expect(html).toContain('dateTime="2026-06-07T10:00:00.000Z"');
    expect(html).toContain('dateTime="2026-06-07T11:00:00.000Z"');
    expect(html).toContain('class="sr-only">Updated Jun 7, 2026, 11:00 AM</span>');
    expect(html).not.toContain('aria-label="Updated');
  });

  it("renders the created date deterministically (UTC) on the server", () => {
    // The server render must not depend on the host timezone, otherwise it
    // mismatches the browser on hydration. createdAt is 2026-06-07T10:00:00Z,
    // so a UTC-pinned formatter yields the 10:00 hour regardless of the
    // timezone this test runs in (a local formatter would shift the hour/day).
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: makeSessionDetailData(),
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    expect(html).toContain("Created Jun 7, 10:00");
  });

  it("renders the session creator when present", () => {
    const data = makeSessionDetailData();
    data.creatorDisplayName = "Ada Lovelace";

    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: data,
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    expect(html).toContain("Ada Lovelace");
  });

  it("keeps the review surface rendered when activity reports a failure", () => {
    const data = makeSessionDetailData();
    data.session.artifacts = [
      {
        createdAt: "2026-06-07T10:30:00.000Z",
        payload: "# Rendered artifact",
        stageSlug: "product",
        version: 1,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        activity: createElement("div", null, "Run activity is temporarily unavailable"),
        initialData: data,
        initialFormattedArtifact: createElement("article", null, "Rendered artifact"),
        initialFormattedArtifactKey: "11111111-1111-4111-8111-111111111111:product:1",
      }),
    );

    expect(html).toContain("Editable Session");
    expect(html).toContain("Product artifact");
    expect(html).toContain("Rendered artifact");
    expect(html).toContain("Run activity is temporarily unavailable");
  });
});
