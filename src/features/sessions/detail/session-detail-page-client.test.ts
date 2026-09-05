// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  centerStageRailSelection,
  reconcilePhaseMutationResult,
  SessionDetailPageClient,
} from "@/features/sessions/detail/session-detail-page-client";
import { useSessionRefresh } from "@/features/sessions/detail/session-refresh-context";
import type { SessionReviewData } from "@/features/sessions/detail/data";

const mocked = vi.hoisted(() => {
  const refresh = vi.fn();
  return {
    refresh,
    router: { refresh, replace: vi.fn() },
    handlers: new Map<string, (payload: unknown) => void>(),
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/acme/sessions/7",
  useRouter: () => mocked.router,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    channel: () => ({
      on: function on(
        _event: string,
        config: { table: string },
        callback: (payload: unknown) => void,
      ) {
        mocked.handlers.set(config.table, callback);
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
      attachments: [],
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
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mocked.refresh.mockReset();
    mocked.handlers.clear();
  });

  it("reconciles recovered snapshots without overwriting newer session state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const data = makeSessionDetailData();
    const element = (value: SessionReviewData, canReview = true) =>
      createElement(SessionDetailPageClient, {
        canReview,
        activity: null,
        initialData: value,
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      });
    const view = render(element(data));
    const fresh = {
      ...data,
      session: { ...data.session, title: "Recovered title", updatedAt: "2026-06-07T12:00:00.000Z" },
    };
    await act(async () => view.rerender(element(fresh)));
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Recovered title");
    await act(async () => view.rerender(element({ ...data, session: { ...data.session } }, false)));
    expect(view.queryByRole("button", { name: "Approve stage" })).toBeNull();
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Recovered title");
    const withPr = {
      ...fresh,
      session: {
        ...fresh.session,
        phaseStatus: "approved" as const,
        pullRequests: [
          {
            id: "recovered-pr",
            pullRequestNumber: 99,
            pullRequestUrl: "https://github.com/acme/app/pull/99",
          },
        ],
      },
    };
    await act(async () => view.rerender(element(withPr)));
    expect(view.getByRole("link", { name: /Open PR #99/ }).getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/99",
    );
  });

  it("preserves a live PR during a tracked refresh and accepts a later quiet deletion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    let finish!: () => void;
    mocked.refresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    function RefreshTrigger() {
      const { refresh } = useSessionRefresh();
      return createElement("button", { onClick: refresh }, "Refresh test");
    }
    const data = makeSessionDetailData();
    data.session.phaseStatus = "approved";
    const element = (value: SessionReviewData) =>
      createElement(SessionDetailPageClient, {
        activity: createElement(RefreshTrigger),
        initialData: value,
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      });
    const view = render(element(data));
    fireEvent.click(view.getByText("Refresh test"));
    act(() =>
      mocked.handlers.get("session_pull_requests")!({
        eventType: "INSERT",
        new: {
          id: "live-pr",
          pull_request_number: 42,
          pull_request_url: "https://github.com/acme/app/pull/42",
          updated_at: "2026-06-07T12:00:00.000Z",
        },
      }),
    );
    await act(async () => {
      view.rerender(element({ ...data, session: { ...data.session } }));
      finish();
    });
    expect(view.getByRole("link", { name: /Open PR #42/ })).toBeTruthy();
    fireEvent.click(view.getByText("Refresh test"));
    await act(async () => {
      view.rerender(element({ ...data, session: { ...data.session } }));
      finish();
    });
    expect(view.queryByRole("link", { name: /Open PR #42/ })).toBeNull();
  });

  it("shows completion only after terminal approval, with each result link", () => {
    const data = makeSessionDetailData();
    data.session.pullRequests = [
      { id: "pr-1", pullRequestNumber: 12, pullRequestUrl: "https://github.com/acme/app/pull/12" },
      { id: "pr-2", pullRequestNumber: 13, pullRequestUrl: "https://github.com/acme/app/pull/13" },
    ];
    expect(renderDetail({ data })).not.toContain("Session complete");
    data.session.archivedAt = "2026-06-07T12:00:00Z";
    expect(renderDetail({ data })).not.toContain("Session complete");
    data.session.phaseStatus = "approved";
    const html = renderDetail({ data });
    expect(html).toContain("Session complete");
    expect(html).toContain("Open PR #12");
    expect(html).toContain("Open PR #13");
    expect(html).not.toContain("Review controls are closed");
    expect(html).not.toContain("sticky bottom-0");
  });

  it("points to stage outputs for completed pipelines without a PR", () => {
    const data = makeSessionDetailData();
    data.session.phaseStatus = "approved";
    const html = renderDetail({ data });
    expect(html).toContain("Explore the stage outputs and run history below.");
    expect(html).toContain("No pull request is linked to this session.");
    expect(html).not.toContain("Open pull request");
  });

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
      phaseStatus: "in_progress",
      rejectionCount: 0,
      updatedAt: "2026-06-07T12:00:00.000Z",
    });

    expect(next.currentStageId).toBe("stage-2");
    expect(next.currentStageSlug).toBe("build");
    expect(next.pipeline.stages).toContainEqual(
      expect.objectContaining({ id: "stage-2", slug: "build" }),
    );
  });

  it("uses the full title itself as the edit affordance", () => {
    const html = renderDetail();
    const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);

    expect(headingMatch).not.toBeNull();
    expect(headingMatch?.[1]).toContain("<button");
    expect(headingMatch?.[1]).toContain("Editable Session</button>");
    expect(html).not.toContain('aria-label="Edit title for session #7"');
    expect(html).not.toContain('aria-label="Session #7 title"');
    expect(html).not.toContain("Save title");
    expect(html).not.toContain("Cancel title edit");
  });

  it("gives mobile titles full width and keeps desktop actions on the right", () => {
    const data = makeSessionDetailData();
    data.session.title =
      "A deliberately long session title that must wrap in full without displacing archive actions";
    const html = renderDetail({ data });
    const headerMatch = html.match(/<header class="([^"]+)">([\s\S]*?)<\/header>/);

    expect(headerMatch).not.toBeNull();
    expect(headerMatch?.[1]).toContain("grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]");
    expect(headerMatch?.[2]).toContain("sm:col-span-2");
    expect(headerMatch?.[2]).toContain(data.session.title);
    expect(headerMatch?.[2]).toContain("Archive");
    expect(headerMatch?.[2]).not.toMatch(/line-clamp|overflow-hidden|truncate/);
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
    expect(html).toContain('class="min-w-0 break-all"');
    expect(html).toContain("Created");
    expect(html).toContain('dateTime="2026-06-07T10:00:00.000Z"');
    expect(html).toContain(">2026-06-07 10:00 UTC</time>");
    expect(html).toContain("Run input");
    expect(html).toContain("acme/app");
  });

  it("does not promise a next stage that live pipeline edits could change", () => {
    const data = makeSessionDetailData();
    data.session.pipeline.stages.push({
      id: "custom-stage",
      slug: "security-check",
      name: "Security check",
      description: "Review security",
      position: 10,
    });
    const html = renderDetail({ data });
    expect(html).toContain("Approve stage");
    expect(html).not.toContain("Approve &amp; start Security check");
    expect(html).toContain("Final-stage approval may also archive the session.");
  });

  it("uses a 70/30 workbench grid with sticky review controls", () => {
    const html = renderDetail();

    expect(html).toContain("lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)]");
    expect(html).not.toContain("lg:border-l");
    expect(html).not.toContain("lg:pl-5");
    expect(html).toContain("sticky bottom-0");
    expect(html).toContain("Request changes");
    expect(html).toContain("Approve stage");
    expect(html).toContain("Final-stage approval may also archive the session.");
    expect(html).toContain('aria-label="Pipeline stages"');
    expect(html).not.toContain("max-h-[480px]");
    expect(html).not.toContain(">Prompt<");
  });

  it("renders runs as a full-width section below the artifact workbench", () => {
    const html = renderDetail({ activity: createElement("div", null, "Run history") });
    const workbenchIndex = html.indexOf("lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)]");
    const runsSectionIndex = html.indexOf('aria-labelledby="session-runs-heading"');

    expect(workbenchIndex).toBeGreaterThan(-1);
    expect(runsSectionIndex).toBeGreaterThan(workbenchIndex);
    expect(html).toContain('class="ui-sheet mt-6"');
    expect(html).toContain('id="session-runs-heading"');
    expect(html).toContain(">Runs</h2>");
    expect(html).toContain("Run history");
    expect(html).not.toContain('aria-label="Inspector"');
    expect(html).not.toContain('id="activity-tab"');
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
    expect(html).toContain("Approve stage");
  });

  it("shows reviewable controls when awaiting review", () => {
    const html = renderDetail();
    expect(html).toContain("Request changes");
    expect(html).toContain("Approve stage");
  });

  it("shows stop run while generating", () => {
    const data = makeSessionDetailData();
    data.session.phaseStatus = "in_progress";
    data.session.pipeline.stages = [
      {
        description: "Shape the approach",
        id: "stage-0",
        name: "Plan",
        position: 0,
        slug: "plan",
      },
      ...data.session.pipeline.stages,
      {
        description: "Ship the change",
        id: "stage-2",
        name: "Land",
        position: 2,
        slug: "land",
      },
    ];
    data.session.phaseCompletions = [
      { completedAt: "2026-06-07T10:30:00.000Z", stageSlug: "plan" },
    ];
    const html = renderDetail({ data });

    expect(html).toContain(">Plan</span>");
    expect(html).toContain(">Product</span>");
    expect(html).toContain(">Land</span>");
    expect(html).toContain("Product artifact");
    expect(html).toContain("Waiting for this stage’s artifact. Follow progress in Runs below.");
    expect(html).toContain("Stop run");
    expect(html.indexOf("Stop run")).toBeLessThan(html.indexOf("Archive"));
    expect(html).not.toContain("Wallie is generating this stage’s artifact.");
    expect(html).not.toContain("sticky bottom-0");
    expect(html).not.toContain("Request changes");
    expect(html).not.toContain("data-status=");
    expect(html).toContain("In progress");
    expect(html).toContain("Completed");
    expect(html).toContain("Upcoming");
  });

  it("shows an explicit completed reason", () => {
    const data = makeSessionDetailData();
    data.session.phaseStatus = "approved";
    const html = renderDetail({ data });
    expect(html).toContain("Session complete");
    expect(html).not.toContain("Request changes");
  });

  it("shows an explicit archived reason", () => {
    const data = makeSessionDetailData();
    data.session.archivedAt = "2026-07-01T00:00:00.000Z";
    const html = renderDetail({ data });
    expect(html).toContain("This session is archived.");
    expect(html).toContain('data-status="archived"');
    expect(html).toContain(">Archived</span>");
    expect(html).not.toContain("Request changes");
  });

  it("keeps Request changes when the viewer cannot approve", () => {
    const html = renderDetail({ canReview: false });
    expect(html).toContain("Request changes");
    expect(html).toContain("You are not authorized to approve this stage.");
    expect(html).not.toContain("Approve stage");
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
    expect(html).toContain("Collapsed — expand to inspect the original session input");
    expect(html).not.toContain("Build the title editor");
  });
});

it("does not promise automatic archival for a Linear-linked manual-merge workflow", () => {
  const data = makeSessionDetailData();
  data.session.linearIssueId = "TEAM-123";
  const html = renderDetail({ data });
  expect(html).toContain("Final-stage approval may also archive the session.");
  expect(html).not.toContain("completes and archives");
});
