// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeArtifactFeedbackSubmissions } from "@/features/sessions/review/submission-events";

import {
  centerStageRailSelection,
  reconcilePhaseMutationResult,
  SessionDetailPageClient,
} from "@/features/sessions/detail/session-detail-page-client";

import {
  SessionActivityPlaceholder,
  useSessionActivityPresentation,
} from "./session-activity-presentation";

import type { ToastInput } from "@/components/ui/toast";
import { OverlayProvider } from "@/components/ui/overlay-provider";
import { useSessionRefresh } from "@/features/sessions/detail/session-refresh-context";
import type { SessionReviewData } from "@/features/sessions/detail/data";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { ExactSessionReviewTarget } from "@/lib/sessions/review-link";

vi.mock("@/features/sessions/detail/use-approval-review", () => ({
  useApprovalReview: () => ({
    confirmedRevision: mocked.approvalReview?.reviewRevision ?? null,
    value: mocked.approvalReview,
    error: null,
    refresh: vi.fn(),
  }),
}));

const feedbackEventCleanups: Array<() => void> = [];
const feedbackArtifactId = "22222222-2222-4222-8222-222222222222";
const feedbackBatchId = "33333333-3333-4333-8333-333333333333";

function watchFeedbackSubmission(sessionId: string) {
  const accepted = vi.fn();
  feedbackEventCleanups.push(
    subscribeArtifactFeedbackSubmissions({ sessionId, artifactId: feedbackArtifactId }, accepted),
  );
  return accepted;
}

vi.mock("@/lib/supabase/realtime-subscription", () => ({
  subscribeAuthenticatedChannel: (
    client: { removeChannel: (channel: unknown) => void },
    channel: { subscribe: (onStatus: unknown) => void },
    onStatus: unknown,
  ) => {
    channel.subscribe(onStatus);
    return () => client.removeChannel(channel);
  },
}));

const mocked = vi.hoisted(() => {
  const refresh = vi.fn();
  return {
    refresh,
    pushToast: vi.fn<(toast: ToastInput) => number>(),
    router: { refresh, replace: vi.fn() },
    statuses: new Map<string, (status: string) => void>(),
    rpc: vi.fn(),
    handlers: new Map<string, (payload: unknown) => void>(),
    approvalReview: { reviewRevision: 7, blockingCount: 0 },
  };
});

vi.mock("@/components/ui/toast", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useOptionalToast: () => ({ pushToast: mocked.pushToast }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/acme/sessions/7",
  useRouter: () => mocked.router,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: vi.fn(() => ({
    rpc: mocked.rpc,
    channel: (name: string) => ({
      on: function on(
        _event: string,
        config: { table: string },
        callback: (payload: unknown) => void,
      ) {
        mocked.handlers.set(config.table, callback);
        return this;
      },
      subscribe: function subscribe(callback: (status: string) => void) {
        mocked.statuses.set(name, callback);
        return this;
      },
    }),
    removeChannel: vi.fn(),
  })),
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
      currentArtifactId: "artifact-1",
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

function exactReviewFixture(overrides: Partial<ExactSessionReviewTarget> = {}) {
  const data = makeSessionDetailData();
  const target = {
    artifactId: feedbackArtifactId,
    artifactVersion: 1,
    stageId: "44444444-4444-4444-8444-444444444444",
    stageSlug: "product",
    reviewRevision: 7,
    clarificationId: null,
    ...overrides,
  };
  data.session.pipeline.stages[0].id = target.stageId;
  data.session.currentStageId = target.stageId;
  data.session.currentArtifactId = target.artifactId;
  const artifact = {
    id: target.artifactId,
    stageSlug: target.stageSlug,
    version: target.artifactVersion,
    createdAt: data.session.updatedAt,
    payload: "Pinned product artifact",
    sanitizedHtml: "<p>Pinned product artifact</p>",
  };
  return { artifact, data, target };
}

function renderExactReview(data: SessionReviewData, target: ExactSessionReviewTarget) {
  return render(
    createElement(SessionDetailPageClient, {
      activity: null,
      initialData: data,
      initialExactReviewTarget: target,
      initialFormattedArtifact: null,
      initialFormattedArtifactKey: null,
    }),
  );
}

afterEach(() => {
  for (const unsubscribe of feedbackEventCleanups.splice(0)) unsubscribe();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mocked.refresh.mockReset();
  mocked.pushToast.mockReset();
  mocked.rpc.mockReset();
  vi.mocked(createSupabaseBrowserClient).mockClear();
  mocked.statuses.clear();
  mocked.handlers.clear();
  mocked.approvalReview = { reviewRevision: 7, blockingCount: 0 };
});

describe("SessionDetailPageClient", () => {
  it("renders the initial review without creating a browser client", () => {
    const markup = renderDetail();
    expect(markup).toContain("Product artifact");
    expect(createSupabaseBrowserClient).not.toHaveBeenCalled();
  });

  it("only submits approval for the pinned artifact and review revision", async () => {
    const { artifact, data, target } = exactReviewFixture();
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/artifacts?")) return Response.json({ artifact });
      return Response.json({ error: "Review is stale." }, { status: 409 });
    });
    renderExactReview(data, target);

    await waitFor(() => expect(screen.getByText(artifact.payload)).toBeVisible());
    fireEvent.click(await screen.findByRole("button", { name: "Approve stage" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        `/api/sessions/${data.session.id}/phase-action`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            action: "approve",
            expectedReviewRevision: target.reviewRevision,
            artifactId: target.artifactId,
            stageId: target.stageId,
            version: target.artifactVersion,
          }),
        }),
      ),
    );
  });

  it("keeps an anchored artifact read-only when a newer review revision exists", async () => {
    const { artifact, data, target } = exactReviewFixture();
    mocked.approvalReview = { reviewRevision: target.reviewRevision + 1, blockingCount: 0 };
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return url.includes("/artifacts?") ? Response.json({ artifact }) : Response.json({});
    });
    renderExactReview(data, target);

    await waitFor(() => expect(screen.getByText(artifact.payload)).toBeVisible());
    expect(screen.getByText("This review link is no longer current.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open current review" })).toHaveAttribute(
      "href",
      "/w/acme/sessions/7",
    );
    expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/phase-action"))).toBe(false);
  });

  it("keeps the exact clarification draft while its current status is being checked", async () => {
    const { artifact, data, target } = exactReviewFixture({
      clarificationId: "55555555-5555-4555-8555-555555555555",
    });
    data.session.specificationStageId = target.stageId;
    const specification = {
      stageId: target.stageId,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      reviewable: true,
      clarification: {
        id: target.clarificationId,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        reviewRevision: target.reviewRevision,
        question: "Which region should launch first?",
        status: "pending",
        executionExhausted: false,
      },
    };
    let readSpecification = Promise.resolve(Response.json(specification));
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/artifacts?")) return Response.json({ artifact });
      if (url.endsWith("/specification") && init?.method !== "POST") return readSpecification;
      return Response.json({});
    });
    renderExactReview(data, target);

    const input = await screen.findByRole("textbox", { name: "Your answer" });
    await waitFor(() => expect(input).toBeEnabled());
    const submit = screen.getByRole("button", { name: "Submit answer" });
    fireEvent.change(input, { target: { value: "Launch in Europe first." } });
    expect(submit).toBeEnabled();

    const inFlight = Promise.withResolvers<Response>();
    readSpecification = inFlight.promise;
    fireEvent.focus(window);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBe(input);
    expect(input).toHaveValue("Launch in Europe first.");
    expect(input).toBeDisabled();
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);

    inFlight.resolve(Response.json(specification));
    await waitFor(() => expect(submit).toBeEnabled());
    expect(input).toHaveValue("Launch in Europe first.");

    readSpecification = Promise.resolve(new Response(null, { status: 403 }));
    fireEvent.focus(window);
    expect(await screen.findByText("Could not verify this review link.")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
  });

  it("does not replace the anchored specification question with a newer question", async () => {
    const { artifact, data, target } = exactReviewFixture({
      clarificationId: "55555555-5555-4555-8555-555555555555",
    });
    data.session.specificationStageId = target.stageId;
    const question = "Which region should launch first?";
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/artifacts?")) return Response.json({ artifact });
      if (url.endsWith("/specification"))
        return Response.json({
          stageId: target.stageId,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          reviewable: true,
          clarification: {
            id: "66666666-6666-4666-8666-666666666666",
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            reviewRevision: target.reviewRevision + 1,
            question,
            status: "pending",
            executionExhausted: false,
          },
        });
      return Response.json({});
    });
    renderExactReview(data, target);

    expect(await screen.findByText("This review link is no longer current.")).toBeVisible();
    await waitFor(() => expect(screen.getByText(artifact.payload)).toBeVisible());
    expect(screen.queryByText(question)).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("does not replace a pinned artifact after the session advances to another stage", async () => {
    const { artifact, data, target } = exactReviewFixture();
    data.session.pipeline.stages.push({
      id: "stage-2",
      slug: "build",
      name: "Build",
      position: 1,
      description: "Build",
    });
    data.session.currentStageId = "stage-2";
    data.session.currentStageSlug = "build";
    data.session.currentArtifactId = "artifact-next";
    data.session.phaseStatus = "in_progress";
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(`artifactId=${artifact.id}`)) return Response.json({ artifact });
      return Response.json({});
    });
    renderExactReview(data, target);

    await waitFor(() => expect(screen.getByText(artifact.payload)).toBeVisible());
    expect(screen.getByRole("region", { name: "Product artifact" })).toBeVisible();
    expect(screen.getByText("This review link is no longer current.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
    expect(request.mock.calls.some(([url]) => String(url).includes("stage=build"))).toBe(false);
  });

  it("allows run-level cancellation for rejected reruns but suppresses it when archived", () => {
    function CancellationProbe() {
      const presentation = useSessionActivityPresentation();
      return createElement(
        "span",
        null,
        presentation?.stopControl === undefined
          ? "Run cancellation available"
          : "Run cancellation suppressed",
      );
    }
    const data = makeSessionDetailData();
    data.session.phaseStatus = "rejected";
    expect(renderDetail({ data, activity: createElement(CancellationProbe) })).toContain(
      "Run cancellation available",
    );
    data.session.archivedAt = data.session.updatedAt;
    expect(renderDetail({ data, activity: createElement(CancellationProbe) })).toContain(
      "Run cancellation suppressed",
    );
  });

  it("keeps session context and input independent of the selected stage, including stages without output", async () => {
    const data = makeSessionDetailData();
    data.creatorDisplayName = "Ada Lovelace";
    data.session.pipeline.stages.push({
      id: "build",
      slug: "build",
      name: "Build",
      description: "Implement",
      position: 1,
    });
    data.session.currentStageId = "build";
    data.session.currentStageSlug = "build";
    data.session.phaseStatus = "in_progress";
    data.session.currentArtifactVersion = 0;
    data.session.phaseCompletions = [
      { stageId: "stage-1", stageSlug: "product", completedAt: data.session.updatedAt },
    ];
    data.session.artifacts = [
      {
        stageSlug: "product",
        version: 1,
        payload: "Approved approach",
        createdAt: data.session.updatedAt,
      },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    render(
      createElement(SessionDetailPageClient, {
        activity: createElement(SessionActivityPlaceholder, null, "Waiting for build"),
        initialData: data,
        initialFormattedArtifact: createElement("p", null, "Approved approach"),
        initialFormattedArtifactKey: `${data.session.id}:product:1`,
      }),
    );
    const context = screen.getByRole("region", { name: "Session context" });
    expect(context.textContent).not.toContain("No Linear issue");
    expect(context.textContent).not.toContain("No pull request");
    expect(screen.queryByRole("region", { name: "Build artifact" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Original request" }));
    expect(screen.getByRole("region", { name: "Original request" }).textContent).toContain(
      data.session.promptMd,
    );
    fireEvent.click(screen.getByRole("button", { name: "Product: Completed" }));
    expect(screen.getByRole("region", { name: "Product artifact" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("artifactStage")).toBe("product");
    fireEvent.click(screen.getByRole("button", { name: "Build: In progress" }));
    expect(screen.queryByRole("region", { name: "Product artifact" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Build artifact" })).toBeNull();
    expect(new URLSearchParams(window.location.search).has("artifactStage")).toBe(false);
    expect(screen.getByRole("region", { name: "Session context" })).toBe(context);
    expect(screen.getByRole("region", { name: "Original request" })).toBeTruthy();
    window.history.replaceState(window.history.state, "", "/");
  });

  it("sends the displayed artifact identity and version before optimistic stage advancement", async () => {
    const data = makeSessionDetailData();
    data.session.currentArtifactVersion = 2;
    data.session.artifacts = [
      {
        id: "artifact-1",
        stageSlug: "product",
        version: 1,
        payload: "Reviewed output",
        createdAt: data.session.updatedAt,
      },
    ];
    data.session.pipeline.stages.push({
      id: "stage-2",
      slug: "build",
      name: "Build",
      position: 1,
      description: "Build",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/phase-action"))
          return Promise.resolve(Response.json({ error: "Review is stale." }, { status: 409 }));
        if (url.endsWith("/approval-review?include=blockingTarget"))
          return Promise.resolve(
            Response.json({ reviewRevision: 7, blockingCount: 0, delivery: null }),
          );
        if (url.endsWith("/review-evidence"))
          return Promise.resolve(Response.json({ delivery: null }));
        return Promise.resolve(Response.json({}));
      });
    render(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: data,
        initialFormattedArtifact: createElement("p", null, "Reviewed output"),
        initialFormattedArtifactKey: `${data.session.id}:product:id:artifact-1`,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve stage" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/sessions/${data.session.id}/phase-action`,
        expect.objectContaining({
          body: JSON.stringify({
            action: "approve",
            expectedReviewRevision: 7,
            artifactId: "artifact-1",
            stageId: "stage-1",
            version: 1,
          }),
          method: "POST",
        }),
      ),
    );
    await waitFor(() =>
      expect(mocked.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Review is stale." }),
      ),
    );
  });

  it("blocks ambiguous review and exposes recovery when current identity is unavailable", () => {
    const data = makeSessionDetailData();
    data.session.currentArtifactId = null;
    data.session.artifacts = [
      {
        id: "legacy-artifact",
        stageSlug: "product",
        version: 1,
        payload: "Old cached output",
        createdAt: data.session.updatedAt,
      },
    ];
    function RecoveryProbe() {
      const presentation = useSessionActivityPresentation();
      return createElement(
        "p",
        null,
        presentation?.reviewIdentityUnavailable ? "Retry recovery enabled" : "No recovery",
      );
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    render(
      createElement(SessionDetailPageClient, {
        activity: createElement(RecoveryProbe),
        initialData: data,
        initialFormattedArtifact: createElement("p", null, "Old cached output"),
        initialFormattedArtifactKey: `${data.session.id}:product:id:legacy-artifact`,
      }),
    );
    expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
    expect(screen.queryByText("Old cached output")).toBeNull();
    expect(screen.getByText(/current artifact cannot be identified safely/i)).toBeTruthy();
    expect(screen.getByText("Retry recovery enabled")).toBeTruthy();
    // The evidence panel reads readiness; it must not fetch a review or mutation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/api/sessions/${data.session.id}/review-evidence`,
    );
  });

  it("does not allow review of a different artifact with the same version", async () => {
    const data = makeSessionDetailData();
    data.session.currentArtifactId = "current-artifact";
    data.session.artifacts = [
      {
        id: "historical-artifact",
        stageSlug: "product",
        version: 1,
        payload: "Historical body",
        createdAt: data.session.updatedAt,
      },
      {
        id: "current-artifact",
        stageSlug: "product",
        version: 1,
        payload: "Current body",
        createdAt: data.session.updatedAt,
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("artifactId=historical-artifact")
        ? Response.json({
            artifact: {
              ...data.session.artifacts[0],
              sanitizedHtml: "<p>Historical formatted</p>",
            },
          })
        : Response.json({
            artifacts: data.session.artifacts.map((artifact) => ({
              ...artifact,
              authorLabel:
                artifact.id === "current-artifact" ? "Current author" : "Historical author",
              attempt: 1,
              changesRequested: false,
            })),
          }),
    );
    render(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: data,
        initialFormattedArtifact: createElement("p", null, "Current formatted"),
        initialFormattedArtifactKey: `${data.session.id}:product:id:current-artifact`,
      }),
    );
    expect(screen.getByText("Current formatted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve stage" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Version 1.*Historical author/i }));
    expect(await screen.findByText("Historical formatted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Version 1.*Current author/i }));
    expect(screen.getByText("Current formatted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve stage" })).toBeTruthy();
  });

  it("preserves the feedback dialog and draft when an optimistic rerun fails", async () => {
    const data = makeSessionDetailData();
    data.session.artifacts = [
      {
        stageSlug: "product",
        version: 1,
        payload: "Review this",
        id: "artifact-1",
        createdAt: data.session.updatedAt,
      },
    ];
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("phase-action"))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      if (String(input).includes("/reviews?"))
        return Response.json({
          reviewRevision: 7,
          submittedThreadRevisions: {},
          threads: [],
          nextCursor: null,
          counts: { total: 0, open: 0, blocking: 0 },
          viewer: { memberId: "member-1", canReview: true, readOnlyReason: null },
        });
      return Response.json({});
    });
    render(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: data,
        initialFormattedArtifact: createElement("p", null, "Review this"),
        initialFormattedArtifactKey: `${data.session.id}:product:id:artifact-1`,
      }),
      { wrapper: OverlayProvider },
    );
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Feedback for Wallie" }), {
      target: { value: "Keep the keyboard focus visible." },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue rerun" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Queue rerun" }));
    const phaseCall = fetchMock.mock.calls.find(([path]) => String(path).includes("phase-action"));
    expect(phaseCall?.[0]).toBe(`/api/sessions/${data.session.id}/phase-action`);
    expect(JSON.parse(String(phaseCall?.[1]?.body))).toEqual({
      action: "reject",
      artifactId: "artifact-1",
      feedbackText: "Keep the keyboard focus visible.",
      feedbackSubmission: {
        requestId: expect.any(String),
        expectedReviewRevision: 7,
        selectedThreadIds: [],
      },
      stageId: "stage-1",
      version: 1,
    });
    expect(screen.getByRole("dialog", { name: "Request changes" })).toBeTruthy();
    expect(document.querySelector('[aria-label="Product artifact"]')).not.toBeNull();
    await act(async () => finish(Response.json({ error: "Try again" }, { status: 500 })));
    expect(
      (screen.getByRole("textbox", { name: "Feedback for Wallie" }) as HTMLTextAreaElement).value,
    ).toBe("Keep the keyboard focus visible.");
    expect(screen.getByRole("button", { name: "Queue rerun" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Try again");
  });

  it("accepts an already committed feedback batch while refreshing its unreconciled session", async () => {
    const data = makeSessionDetailData();
    data.session.currentArtifactId = feedbackArtifactId;
    const accepted = watchFeedbackSubmission(data.session.id);
    data.session.artifacts = [
      {
        stageSlug: "product",
        version: 1,
        payload: "Review this",
        id: feedbackArtifactId,
        createdAt: data.session.updatedAt,
      },
    ];
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("/reviews?"))
        return Response.json({
          reviewRevision: 7,
          submittedThreadRevisions: {},
          threads: [
            {
              id: "thread-1",
              revision: 1,
              status: "open",
              kind: "discussion",
              anchor: { quote: "Review this" },
            },
          ],
          nextCursor: null,
          counts: { total: 1, open: 1, blocking: 0 },
          viewer: { memberId: "member-1", canReview: true, readOnlyReason: null },
        });
      if (String(input).includes("phase-action")) {
        calls.push(JSON.parse(String(init?.body)));
        return Response.json(
          {
            feedbackBatchId,
            revisionJobId: "job-1",
            revisionRunId: "run-1",
            revisionGeneration: "job-1",
            reconciliationRequired: true,
          },
          { status: 202 },
        );
      }
      return Response.json({});
    });
    render(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: data,
        initialFormattedArtifact: createElement("p", null, "Review this"),
        initialFormattedArtifactKey: `${data.session.id}:product:id:${feedbackArtifactId}`,
      }),
      { wrapper: OverlayProvider },
    );
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Include thread: Review this" }));
    fireEvent.click(screen.getByRole("button", { name: "Queue rerun" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Request changes" })).toBeNull(),
    );
    expect(calls).toHaveLength(1);
    expect(accepted).toHaveBeenCalledExactlyOnceWith({
      sessionId: data.session.id,
      artifactId: feedbackArtifactId,
      batchId: feedbackBatchId,
    });
    expect(calls[0]).toMatchObject({
      action: "reject",
      feedbackText: "",
      feedbackSubmission: { expectedReviewRevision: 7, selectedThreadIds: ["thread-1"] },
    });
    await waitFor(() => expect(mocked.refresh).toHaveBeenCalledOnce());
    expect(mocked.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Changes queued.", tone: "success" }),
    );
    expect(mocked.pushToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not queue changes." }),
    );
  });

  it.each([
    {
      label: "a normal accepted batch",
      action: "reject" as const,
      status: 200,
      batch: true,
      notifies: true,
    },
    {
      label: "a rejected submission",
      action: "reject" as const,
      status: 500,
      batch: true,
      notifies: false,
    },
    { label: "an approval", action: "approve" as const, status: 200, batch: true, notifies: false },
    {
      label: "a response without a batch receipt",
      action: "reject" as const,
      status: 200,
      batch: false,
      notifies: false,
    },
  ])(
    "publishes coverage invalidation only for accepted feedback: $label",
    async ({ action, status, batch, notifies }) => {
      const data = makeSessionDetailData();
      data.session.currentArtifactId = feedbackArtifactId;
      data.session.artifacts = [
        {
          stageSlug: "product",
          version: 1,
          payload: "Review this",
          id: feedbackArtifactId,
          createdAt: data.session.updatedAt,
        },
      ];
      const accepted = watchFeedbackSubmission(data.session.id);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/reviews?"))
          return Response.json({
            reviewRevision: 7,
            submittedThreadRevisions: {},
            threads: [],
            nextCursor: null,
            counts: { total: 0, open: 0, blocking: 0 },
            viewer: { memberId: "member-1", canReview: true, readOnlyReason: null },
          });
        if (String(input).includes("phase-action"))
          return Response.json(
            {
              id: data.session.id,
              archivedAt: null,
              currentArtifactId: feedbackArtifactId,
              artifactVersion: 1,
              currentStageId: data.session.currentStageId,
              currentStage: data.session.pipeline.stages[0],
              phaseStatus: action === "reject" ? "rejected" : "approved",
              rejectionCount: 1,
              updatedAt: "2026-06-07T12:00:00.000Z",
              feedbackBatchId: batch ? feedbackBatchId : undefined,
              ...(status >= 400 ? { error: "Submission rejected." } : {}),
            },
            { status },
          );
        return Response.json({});
      });
      render(
        createElement(SessionDetailPageClient, {
          activity: null,
          initialData: data,
          initialFormattedArtifact: createElement("p", null, "Review this"),
          initialFormattedArtifactKey: `${data.session.id}:product:id:${feedbackArtifactId}`,
        }),
        { wrapper: OverlayProvider },
      );
      if (action === "approve")
        fireEvent.click(screen.getByRole("button", { name: "Approve stage" }));
      else {
        fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
        fireEvent.change(await screen.findByLabelText("Feedback for Wallie"), {
          target: { value: "Please revise this." },
        });
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Queue rerun" })).toBeEnabled(),
        );
        fireEvent.click(screen.getByRole("button", { name: "Queue rerun" }));
      }
      await waitFor(() =>
        expect(mocked.pushToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title:
              status >= 400
                ? "Could not queue changes."
                : action === "reject"
                  ? "Changes queued."
                  : "Review approved.",
          }),
        ),
      );
      if (notifies)
        expect(accepted).toHaveBeenCalledExactlyOnceWith({
          sessionId: data.session.id,
          artifactId: feedbackArtifactId,
          batchId: feedbackBatchId,
        });
      else expect(accepted).not.toHaveBeenCalled();
    },
  );

  it("refreshes after a successful archive Undo has cleared its pending state", async () => {
    const data = makeSessionDetailData();
    const archivedAt = "2026-06-07T12:00:00.000Z";
    let finishUndo!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          finishUndo = resolve;
        });
      }
      return Response.json({
        id: data.session.id,
        archivedAt,
        phaseStatus: "awaiting_review",
        updatedAt: archivedAt,
      });
    });
    const view = render(
      createElement(SessionDetailPageClient, {
        canReview: true,
        activity: null,
        initialData: data,
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Archive" })));
    const undo = mocked.pushToast.mock.calls.find(([toast]) => toast.action?.label === "Undo")?.[0]
      .action;
    expect(undo).toBeDefined();
    await act(async () => undo!.onClick());
    expect((view.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(mocked.refresh).not.toHaveBeenCalled();
    mocked.refresh.mockImplementation(() => {
      expect((view.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    await act(async () =>
      finishUndo(
        Response.json({
          id: data.session.id,
          archivedAt: null,
          phaseStatus: "awaiting_review",
          updatedAt: "2026-06-07T12:01:00.000Z",
        }),
      ),
    );
    expect(mocked.refresh).toHaveBeenCalledTimes(1);
  });

  it("asks before stopping a queued rerun and Undo only unarchives", async () => {
    class ResizeObserverStub {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const data = makeSessionDetailData();
    data.session.phaseStatus = "rejected";
    const archivedAt = "2026-06-07T12:00:00.000Z";
    const requests: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!url.endsWith("/archive")) return Response.json({});
        requests.push(init?.method);
        return Response.json({
          id: data.session.id,
          archivedAt: init?.method === "DELETE" ? null : archivedAt,
          phaseStatus: "rejected",
          updatedAt: archivedAt,
        });
      }),
    );
    render(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionDetailPageClient, {
          activity: null,
          initialData: data,
          initialFormattedArtifact: null,
          initialFormattedArtifactKey: null,
          latestRun: {
            id: "queued-run",
            stageId: data.session.currentStageId,
            createdAt: data.session.updatedAt,
            updatedAt: data.session.updatedAt,
            status: "queued",
          },
        }),
      ),
    );
    const archive = screen.getByRole("button", { name: "Archive" });
    fireEvent.click(archive);
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveAccessibleDescription(/Unarchiving won’t restart this run/);
    expect(requests).toEqual([]);
    const cancel = within(confirmation).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.click(cancel);
    await waitFor(() => expect(archive).toHaveFocus());
    expect(requests).toEqual([]);
    fireEvent.click(archive);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Stop run and archive" })),
    );
    expect(requests).toEqual(["POST"]);
    const undo = mocked.pushToast.mock.calls.find(([toast]) => toast.action?.label === "Undo")?.[0];
    expect(undo?.description).toMatch(/doesn’t restart the run/);
    await act(async () => undo?.action?.onClick());
    expect(requests).toEqual(["POST", "DELETE"]);
    expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
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
    await waitFor(() => expect(mocked.handlers.has("session_pull_requests")).toBe(true));
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
    expect(html).toContain("Approval does not merge the pull request or deploy the code");
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

  it("gives the title full width below the breadcrumb and archive actions", () => {
    const data = makeSessionDetailData();
    data.session.title =
      "A deliberately long session title that must wrap in full without displacing archive actions";
    const html = renderDetail({ data });
    const headerMatch = html.match(/<header class="([^"]+)">([\s\S]*?)<\/header>/);

    expect(headerMatch).not.toBeNull();
    expect(headerMatch?.[2]?.indexOf("Archive")).toBeLessThan(
      headerMatch?.[2]?.indexOf("<h1") ?? 0,
    );
    expect(headerMatch?.[2]).toContain(data.session.title);
    expect(headerMatch?.[2]).toContain('aria-label="Archive"');
    expect(headerMatch?.[2]).not.toMatch(/line-clamp|overflow-hidden|truncate/);
  });

  it("renders the header Archive control as a compact icon button", () => {
    const html = renderDetail();
    const document = new DOMParser().parseFromString(html, "text/html");
    const archive = document.querySelector('header button[aria-label="Archive"]');

    expect(archive).not.toBeNull();
    expect(archive?.className.split(/\s+/)).toContain("ui-icon-button");
    expect(archive?.className.split(/\s+/)).not.toContain("ui-button");
    expect(archive?.textContent?.trim()).toBe("");
    expect(archive?.querySelector("[data-action-label]")).toBeNull();
    expect(archive?.innerHTML).not.toContain(">Archive<");
    expect(html).not.toContain('idle="Archive"');
  });

  it("folds the session number into the breadcrumb instead of an orphaned row", () => {
    const document = new DOMParser().parseFromString(renderDetail(), "text/html");
    const breadcrumb = document.querySelector('nav[aria-label="Breadcrumb"]');
    const backLink = breadcrumb?.querySelector("a");
    expect(backLink?.getAttribute("href")).toBe("/w/acme/sessions");
    expect(backLink?.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe("←");
    expect(breadcrumb?.textContent?.trim()).toMatch(/Sessions\s*\/\s*#7$/);
  });

  it("keeps creator and creation time in the compact session header", () => {
    const data = makeSessionDetailData();
    data.creatorDisplayName = "Ada Lovelace";
    const html = renderDetail({ data });

    expect(html).toContain("Ada Lovelace");
    expect(html.indexOf("Ada Lovelace")).toBeLessThan(html.indexOf('aria-label="Pipeline stages"'));
    expect(html).toContain("Created");
    expect(html).toContain('dateTime="2026-06-07T10:00:00.000Z"');
    expect(html).toContain(">2026-06-07 10:00 UTC</time>");
    expect(html).toContain("Original request");
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

  it("attaches review controls to the artifact and keeps session context above stages", () => {
    const html = renderDetail();
    const document = new DOMParser().parseFromString(html, "text/html");
    const artifact = document.querySelector('section[aria-label="Product artifact"]')!;
    expect(artifact.textContent).toContain("Request changes");
    expect(artifact.textContent).toContain("Approve stage");
    expect(artifact.querySelector('[aria-label="Session context"]')).toBeNull();
    expect(document.querySelector('header [aria-label="Session context"]')).not.toBeNull();
    expect(html).not.toContain('aria-label="Current execution"');
  });

  it("shows run history below a reviewable artifact with a section heading", () => {
    const html = renderDetail({ activity: createElement("div", null, "Loaded run activity") });
    const document = new DOMParser().parseFromString(html, "text/html");
    const runs = document.querySelector('section[aria-label="Session runs"]')!;
    expect(runs.querySelector("h2")?.textContent).toBe("Run history");
    expect(runs.querySelector("summary")).toBeNull();
    expect(runs.textContent).toContain("Loaded run activity");
    expect(html.indexOf('aria-label="Session runs"')).toBeGreaterThan(
      html.indexOf("Product artifact"),
    );
  });

  it("keeps the review surface rendered when activity is deferred", () => {
    const data = makeSessionDetailData();
    data.session.artifacts = [
      {
        createdAt: "2026-06-07T10:30:00.000Z",
        id: "artifact-1",
        payload: "# Rendered artifact",
        stageSlug: "product",
        version: 1,
      },
    ];
    const html = renderDetail({
      activity: createElement("div", null, "Run activity is temporarily unavailable"),
      data,
      initialFormattedArtifact: createElement("article", null, "Rendered artifact"),
      initialFormattedArtifactKey: "11111111-1111-4111-8111-111111111111:product:id:artifact-1",
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
    const html = renderDetail({
      data,
      activity: createElement(SessionActivityPlaceholder, null, "Loading activity…"),
    });

    expect(html).toContain(">Plan</span>");
    expect(html).toContain(">Product</span>");
    expect(html).toContain(">Land</span>");
    expect(html).not.toContain("Product artifact");
    expect(html).not.toContain("Waiting for this stage’s artifact");
    expect(html).toContain("Stop run");
    expect(html).toContain("ui-button text-danger");
    expect(html.indexOf("Stop run")).toBeGreaterThan(html.indexOf('aria-label="Archive"'));
    const document = new DOMParser().parseFromString(html, "text/html");
    const archive = document.querySelector('header button[aria-label="Archive"]');
    expect(archive?.className.split(/\s+/)).toContain("ui-icon-button");
    expect(archive?.textContent?.trim()).toBe("");
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
    const document = new DOMParser().parseFromString(html, "text/html");
    const unarchive = [...document.querySelectorAll("header button")].find((button) =>
      button.textContent?.includes("Unarchive"),
    );
    expect(html).toContain("This archived session is read-only.");
    expect(document.querySelector('header [data-status="archived"]')).toBeNull();
    expect(html).not.toContain("Request changes");
    expect(unarchive).toBeDefined();
    expect(unarchive?.className.split(/\s+/)).toContain("ui-button");
    expect(unarchive?.textContent).toContain("Unarchive");
    expect(document.querySelector('header button[aria-label="Archive"]')).toBeNull();
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
    expect(html).toContain("Earlier output · not ready for review");
    expect(html).not.toContain("Product artifact");
    expect(html).not.toContain("Request changes");
  });

  it("keeps the original request collapsed by default in the header", () => {
    const html = renderDetail();
    expect(html).toContain("Original request");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Collapsed — expand");
    expect(html).not.toContain("Build the title editor");
  });
});

it("replays an unconfirmed exact clarification answer and keeps approval closed", async () => {
  const initial = makeSessionDetailData();
  const stageId = "44444444-4444-4444-8444-444444444444";
  const clarificationId = "55555555-5555-4555-8555-555555555555";
  initial.session.pipeline.stages[0].id = stageId;
  initial.session.currentStageId = stageId;
  initial.session.specificationStageId = stageId;
  initial.session.currentArtifactId = feedbackArtifactId;
  const artifact = {
    id: feedbackArtifactId,
    createdAt: initial.session.updatedAt,
    stageSlug: "product",
    version: 1,
    payload: "Initial specification",
    sanitizedHtml: "<p>Initial specification</p>",
  };
  initial.session.artifacts = [artifact];
  const clarification = {
    id: clarificationId,
    artifactId: feedbackArtifactId,
    artifactVersion: 1,
    reviewRevision: 7,
    question: "Which region should launch first?",
    status: "pending",
    executionExhausted: false,
  };
  const attempts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/specification") && init?.method === "POST") {
        attempts.push(String(init.body));
        return attempts.length === 1
          ? new Response(null, { status: 502 })
          : Response.json({
              clarificationId,
              feedbackBatchId,
              jobId: "66666666-6666-4666-8666-666666666666",
              runId: "77777777-7777-4777-8777-777777777777",
              executionExhausted: false,
              replayed: true,
            });
      }
      if (url.endsWith("/specification"))
        return Response.json({
          stageId,
          artifactId: feedbackArtifactId,
          artifactVersion: 1,
          reviewable: true,
          clarification,
        });
      if (url.includes("/artifacts")) return Response.json({ artifact });
      return new Response(null, { status: 404 });
    }),
  );

  render(
    createElement(SessionDetailPageClient, {
      activity: null,
      initialData: initial,
      initialFormattedArtifact: null,
      initialFormattedArtifactKey: null,
    }),
  );

  expect(screen.getByRole("heading", { name: "Specification" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Versions" })).toBeVisible();
  expect(await screen.findByRole("heading", { name: "Clarification needed" })).toBeVisible();
  expect(screen.getByText(clarification.question)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();

  const input = screen.getByRole("textbox", { name: "Your answer" });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: "  Start in Europe.  " } });
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  expect(await screen.findByText("Answer unconfirmed. Your draft was kept.")).toBeVisible();
  expect(input).toHaveValue("  Start in Europe.  ");
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

  expect(await screen.findByRole("heading", { name: "Clarification answered" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
  expect(JSON.parse(attempts[0])).toMatchObject({
    clarificationId,
    artifactId: feedbackArtifactId,
    artifactVersion: 1,
    reviewRevision: 7,
    answer: "Start in Europe.",
  });
  expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
  expect(mocked.refresh).toHaveBeenCalled();
});

it("waits for an authoritative current specification before offering approval", async () => {
  const initial = makeSessionDetailData();
  const stageId = "44444444-4444-4444-8444-444444444444";
  initial.session.pipeline.stages[0].id = stageId;
  initial.session.currentStageId = stageId;
  initial.session.specificationStageId = stageId;
  initial.session.currentArtifactId = feedbackArtifactId;
  const artifact = {
    id: feedbackArtifactId,
    createdAt: initial.session.updatedAt,
    stageSlug: "product",
    version: 1,
    payload: "Review this specification",
    sanitizedHtml: "<p>Review this specification</p>",
  };
  initial.session.artifacts = [artifact];
  const exact = {
    stageId,
    artifactId: feedbackArtifactId,
    artifactVersion: 1,
    reviewable: true,
    clarification: null,
  };
  const states = [
    { ...exact, artifactId: "55555555-5555-4555-8555-555555555555", artifactVersion: 2 },
    { ...exact, reviewable: false },
    exact,
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/specification")) return Response.json(states.shift());
      if (url.includes("/artifacts")) return Response.json({ artifact });
      return new Response(null, { status: 404 });
    }),
  );

  render(
    createElement(SessionDetailPageClient, {
      activity: null,
      initialData: initial,
      initialFormattedArtifact: null,
      initialFormattedArtifactKey: null,
    }),
  );
  for (let refresh = 0; refresh < 2; refresh++) {
    expect(await screen.findByText("Could not confirm clarification status.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh clarification" }));
  }
  expect(await screen.findByRole("button", { name: "Approve stage" })).toBeEnabled();
  expect(mocked.refresh).toHaveBeenCalled();
});

it("shows an accepted budget exhaustion after reloading the parked specification", async () => {
  const initial = makeSessionDetailData();
  const stageId = "44444444-4444-4444-8444-444444444444";
  initial.session.pipeline.stages[0].id = stageId;
  initial.session.currentStageId = stageId;
  initial.session.specificationStageId = stageId;
  initial.session.currentArtifactId = feedbackArtifactId;
  initial.session.phaseStatus = "rejected";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.endsWith("/specification")) return new Response(null, { status: 404 });
      return Response.json({
        stageId,
        artifactId: feedbackArtifactId,
        artifactVersion: 1,
        reviewable: false,
        clarification: {
          id: "55555555-5555-4555-8555-555555555555",
          artifactId: feedbackArtifactId,
          artifactVersion: 1,
          reviewRevision: 7,
          question: "Which region should launch first?",
          status: "answered",
          executionExhausted: true,
        },
      });
    }),
  );
  function RunRetryPolicy() {
    return createElement("span", null, useSessionActivityPresentation()?.retryUnavailableReason);
  }
  render(
    createElement(SessionDetailPageClient, {
      activity: createElement(RunRetryPolicy),
      initialData: initial,
      initialFormattedArtifact: null,
      initialFormattedArtifactKey: null,
    }),
  );

  expect(
    await screen.findByText(
      "The execution budget is exhausted. No specification revision was queued.",
    ),
  ).toBeVisible();
  expect(screen.getByText("The specification’s execution budget is exhausted.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
});

it("does not promise automatic archival for a Linear-linked manual-merge workflow", () => {
  const data = makeSessionDetailData();
  data.session.linearIssueId = "TEAM-123";
  const html = renderDetail({ data });
  expect(html).toContain("Final-stage approval may also archive the session.");
  expect(html).not.toContain("completes and archives");
});

it("discovers an artifact completed during a subscription outage without a route refresh", async () => {
  const initial = makeSessionDetailData();
  initial.session.phaseStatus = "in_progress";
  initial.session.currentArtifactVersion = 0;
  const incoming = makeSessionDetailData();
  const artifact = {
    id: "artifact-1",
    createdAt: "2026-06-07T12:00:00.000Z",
    stageSlug: "product",
    version: 1,
    payload: "Artifact saved while offline",
    sanitizedHtml: "<p>Artifact saved while offline</p>",
  };
  incoming.session.updatedAt = artifact.createdAt;
  incoming.session.artifacts = [artifact];
  mocked.rpc.mockImplementation((name: string) => ({
    abortSignal: () =>
      Promise.resolve({
        data: name === "get_session_prompt_attachments" ? [] : incoming,
        error: null,
      }),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("/artifacts")
              ? { artifact }
              : {
                  stageId: incoming.session.currentStageId,
                  canApprove: true,
                  hasFailedRun: false,
                  failedStageSlug: null,
                },
          ),
        ),
    ),
  );
  mocked.refresh.mockClear();
  render(
    createElement(SessionDetailPageClient, {
      activity: null,
      initialData: initial,
      initialFormattedArtifact: null,
      initialFormattedArtifactKey: null,
    }),
  );
  await waitFor(() =>
    expect(mocked.statuses.has(`session-detail:${initial.session.id}`)).toBe(true),
  );
  act(() => mocked.statuses.get(`session-detail:${initial.session.id}`)?.("CHANNEL_ERROR"));
  await waitFor(() => expect(screen.getByText("Artifact saved while offline")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Approve stage" })).toBeTruthy();
  expect(mocked.refresh).not.toHaveBeenCalled();
  expect(mocked.rpc).toHaveBeenCalledWith("get_session_detail_page", {
    target_session_number: 7,
    target_workspace_slug: "acme",
  });
});

it.each([null, { access: { hasAnyWorkspace: false } }, { access: { hasAnyWorkspace: true } }])(
  "leaves the stale detail page when recovery returns %j",
  async (payload) => {
    const initial = makeSessionDetailData();
    mocked.rpc.mockImplementation((name: string) => ({
      abortSignal: () =>
        Promise.resolve({
          data: name === "get_session_prompt_attachments" ? [] : payload,
          error: null,
        }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          stageId: initial.session.currentStageId,
          canApprove: true,
          hasFailedRun: false,
        }),
      ),
    );
    mocked.router.replace.mockClear();
    const view = render(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: initial,
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );
    await waitFor(() =>
      expect(mocked.statuses.has(`session-detail:${initial.session.id}`)).toBe(true),
    );
    act(() => mocked.statuses.get(`session-detail:${initial.session.id}`)?.("CHANNEL_ERROR"));
    await waitFor(() => expect(mocked.router.replace).toHaveBeenCalledWith("/w/acme/sessions"));
    view.unmount();
    vi.unstubAllGlobals();
  },
);

it("waits for matching stage data before enabling recovered approval permissions", async () => {
  vi.useFakeTimers();
  const initial = makeSessionDetailData();
  let incoming = initial;
  mocked.rpc.mockImplementation((name: string) => ({
    abortSignal: () =>
      Promise.resolve({
        data: name === "get_session_prompt_attachments" ? [] : incoming,
        error: null,
      }),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        stageId: "stage-2",
        canApprove: true,
        hasFailedRun: false,
        failedStageSlug: null,
      }),
    ),
  );
  render(
    createElement(SessionDetailPageClient, {
      activity: null,
      canReview: false,
      initialData: initial,
      initialFormattedArtifact: null,
      initialFormattedArtifactKey: null,
    }),
  );
  await act(async () => {});
  expect(mocked.statuses.has(`session-detail:${initial.session.id}`)).toBe(true);
  act(() => mocked.statuses.get(`session-detail:${initial.session.id}`)?.("CHANNEL_ERROR"));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(screen.queryByRole("button", { name: "Approve stage" })).toBeNull();
  expect(screen.getByText("Product artifact")).toBeTruthy();

  incoming = makeSessionDetailData();
  incoming.session.currentStageId = "stage-2";
  incoming.session.currentStageSlug = "build";
  incoming.session.updatedAt = "2026-06-07T12:00:00.000Z";
  incoming.session.pipeline.stages.push({
    id: "stage-2",
    slug: "build",
    name: "Build",
    description: "Build the change",
    position: 1,
  });
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(screen.getByText("Build artifact")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Approve stage" })).toBeTruthy();
});

it("renders queued startup before activity loads and retains it across a stale page refresh", () => {
  const data = makeSessionDetailData();
  data.session.phaseStatus = "rejected";
  const run = {
    id: "rerun",
    stageId: "stage-1",
    status: "queued" as const,
    createdAt: "2026-06-07T12:01:00.000Z",
    updatedAt: "2026-06-07T12:01:00.000Z",
  };
  const props = {
    activity: null,
    initialData: data,
    latestRun: run,
    failedStageSlug: "product",
    hasFailedRun: true,
    initialFormattedArtifact: null,
    initialFormattedArtifactKey: null,
  };
  // Server HTML is already correct before effects or the deferred activity mount.
  const html = renderToStaticMarkup(createElement(SessionDetailPageClient, props));
  expect(html).toContain('aria-label="Product: Queued"');
  expect(html).not.toContain('aria-label="Product: Failed"');
  const view = render(createElement(SessionDetailPageClient, props));
  const assertQueued = () => {
    const button = screen.getByRole("button", { name: "Product: Queued" });
    expect(button).toHaveAttribute("aria-current", "step");
    expect(button.querySelector('[aria-hidden="true"]')).toHaveTextContent("1");
  };
  assertQueued();
  view.rerender(
    createElement(SessionDetailPageClient, {
      ...props,
      initialData: { ...data, session: { ...data.session } },
      latestRun: {
        ...run,
        id: "old-error",
        status: "error",
        createdAt: data.session.createdAt,
        updatedAt: data.session.updatedAt,
      },
    }),
  );
  assertQueued();
});
