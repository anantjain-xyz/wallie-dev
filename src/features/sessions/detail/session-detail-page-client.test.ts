import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  mergeFetchedArtifacts,
  SessionDetailPageClient,
} from "@/features/sessions/detail/session-detail-page-client";
import type { SessionDetailPageData } from "@/features/sessions/detail/data";

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

function makeSessionDetailData(): SessionDetailPageData {
  return {
    currentMember: null,
    members: [],
    memberIndex: new Map(),
    session: {
      archivedAt: null,
      artifacts: [],
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
      phaseCompletions: [],
      phaseStatus: "awaiting_review",
      pipeline: {
        id: "pipeline-1",
        isDefault: true,
        name: "Default",
        operatingRulesMd: "",
        stages: [
          {
            approverMemberIds: [],
            description: "Define the product",
            id: "stage-1",
            name: "Product",
            pipelineId: "pipeline-1",
            position: 0,
            promptTemplateMd: "",
            slug: "product",
          },
        ],
      },
      pipelineId: "pipeline-1",
      promptMd: "Build the title editor",
      pullRequestCount: 0,
      pullRequests: [],
      rejectionCount: 0,
      title: "Editable Session",
      updatedAt: "2026-06-07T11:00:00.000Z",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    },
    sessionCreator: null,
    sessionGithubRepositoryId: null,
    wallie: {
      blockingReasons: [],
      canEnqueue: false,
      loadedMessageRunIds: [],
      missingSecretKeys: [],
      mode: "code",
      repository: null,
      requiredSecretKeys: [],
      requiresVercelSandbox: false,
      runs: [],
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: null,
        projectId: null,
        projectName: null,
        status: "missing",
        teamId: null,
      },
    },
    workspace: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Acme",
      slug: "acme",
    },
  };
}

describe("SessionDetailPageClient", () => {
  it("renders an accessible title edit affordance alongside the session title", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        initialData: makeSessionDetailData(),
      }),
    );

    expect(html).toContain("Editable Session");
    expect(html).toContain('aria-label="Edit title for session #7"');
    expect(html).toContain('title="Edit title"');
    expect(html).not.toContain('aria-label="Session #7 title"');
  });

  it("keeps the edit control outside the heading so the heading name is only the title", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        initialData: makeSessionDetailData(),
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
        initialData: makeSessionDetailData(),
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
        initialData: makeSessionDetailData(),
      }),
    );

    expect(html).toContain("Created");
    expect(html).toContain("Updated");
  });

  it("renders the created date deterministically (UTC) on the server", () => {
    // The server render must not depend on the host timezone, otherwise it
    // mismatches the browser on hydration. createdAt is 2026-06-07T10:00:00Z,
    // so a UTC-pinned formatter yields the 10:00 hour regardless of the
    // timezone this test runs in (a local formatter would shift the hour/day).
    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        initialData: makeSessionDetailData(),
      }),
    );

    expect(html).toContain("Created Jun 7, 10:00");
  });

  it("renders the session creator when present", () => {
    const data = makeSessionDetailData();
    data.sessionCreator = {
      avatarUrl: null,
      fullName: "Ada Lovelace",
      id: "creator-1",
      isActive: true,
      kind: "human",
      role: "member",
      userId: "user-1",
      username: "ada",
    };

    const html = renderToStaticMarkup(
      createElement(SessionDetailPageClient, {
        initialData: data,
      }),
    );

    expect(html).toContain("Ada Lovelace");
  });
});

describe("mergeFetchedArtifacts", () => {
  it("keeps realtime artifacts when a stale history fetch returns", () => {
    expect(
      mergeFetchedArtifacts(
        [
          {
            createdAt: "2026-06-07T11:01:00.000Z",
            payload: { markdown: "realtime artifact" },
            stageSlug: "build",
            version: 2,
          },
        ],
        [
          {
            createdAt: "2026-06-07T11:00:00.000Z",
            payload: { markdown: "stale fetched artifact" },
            stageSlug: "build",
            version: 2,
          },
          {
            createdAt: "2026-06-07T10:00:00.000Z",
            payload: { markdown: "older fetched artifact" },
            stageSlug: "build",
            version: 1,
          },
        ],
      ),
    ).toEqual([
      {
        createdAt: "2026-06-07T11:01:00.000Z",
        payload: { markdown: "realtime artifact" },
        stageSlug: "build",
        version: 2,
      },
      {
        createdAt: "2026-06-07T10:00:00.000Z",
        payload: { markdown: "older fetched artifact" },
        stageSlug: "build",
        version: 1,
      },
    ]);
  });
});
