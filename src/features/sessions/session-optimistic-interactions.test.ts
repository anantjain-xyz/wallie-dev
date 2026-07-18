// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { SessionDetailPageClient } from "@/features/sessions/detail/session-detail-page-client";
import type { SessionReviewData } from "@/features/sessions/detail/data";
import { SessionsPageClient } from "@/features/sessions/list/sessions-page-client";
import type { SessionListPageData } from "@/features/sessions/list/data";
import type { SessionSummary } from "@/features/sessions/types";

const mocked = vi.hoisted(() => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);

  return {
    channel,
    fetch: vi.fn(),
    removeChannel: vi.fn(),
    replace: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocked.replace }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    channel: () => mocked.channel,
    removeChannel: mocked.removeChannel,
  }),
}));

vi.mock("@/features/sessions/detail/artifact-panel", () => ({
  ArtifactPanel: ({ isDrafting, loadLatest }: { isDrafting: boolean; loadLatest: boolean }) =>
    createElement(
      "div",
      null,
      isDrafting ? "Drafting artifact" : loadLatest ? "Artifact ready" : "Artifact",
    ),
}));

vi.mock("@/features/wallie/session-wallie-panel", () => ({
  SessionWalliePanel: () => null,
}));

const session: SessionSummary = {
  archivedAt: null,
  createdAt: "2026-07-17T10:00:00.000Z",
  currentArtifactVersion: 1,
  currentStageId: "stage-plan",
  currentStageName: "Plan",
  currentStagePosition: 0,
  currentStageSlug: "plan",
  id: "11111111-1111-4111-8111-111111111111",
  linearIssueId: null,
  linearIssueUrl: null,
  number: 1,
  phaseStatus: "awaiting_review",
  pipelineId: "pipeline-1",
  promptMd: "Ship the optimistic flow",
  pullRequestCount: 0,
  pullRequests: [],
  rejectionCount: 0,
  title: "Optimistic session",
  updatedAt: "2026-07-17T11:00:00.000Z",
  workspaceId: "workspace-1",
};

function makeDetailData(): SessionReviewData {
  return {
    creatorDisplayName: null,
    session: {
      archivedAt: session.archivedAt,
      artifacts: [],
      createdAt: session.createdAt,
      currentArtifactVersion: session.currentArtifactVersion,
      currentStageId: session.currentStageId,
      currentStageSlug: session.currentStageSlug,
      id: session.id,
      linearIssueId: session.linearIssueId,
      linearIssueUrl: session.linearIssueUrl,
      number: session.number,
      phaseCompletions: [],
      phaseStatus: session.phaseStatus,
      pipeline: {
        stages: [
          {
            description: "Plan",
            id: "stage-plan",
            name: "Plan",
            position: 0,
            slug: "plan",
          },
          {
            description: "Build",
            id: "stage-build",
            name: "Build",
            position: 1,
            slug: "build",
          },
        ],
      },
      promptMd: session.promptMd,
      pullRequests: [],
      rejectionCount: session.rejectionCount,
      title: session.title,
      updatedAt: session.updatedAt,
    },
    workspaceSlug: "acme",
  };
}

function makeListData(summary: SessionSummary, scope: "all" | "archived"): SessionListPageData {
  return {
    hasAnySession: true,
    hasMore: false,
    nextCursor: null,
    onboarding: null,
    queryState: { cursor: null, query: "", scope, stageSlug: null },
    sessions: [summary],
    stageFacets: [{ count: 1, name: "Plan", position: 0, slug: "plan" }],
    totalCount: 1,
    workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
  };
}

describe("optimistic session interactions", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocked.fetch);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocked.channel.on.mockReturnValue(mocked.channel);
    mocked.channel.subscribe.mockReturnValue(mocked.channel);
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
  });

  it("does not expose Stop while a delayed approval is still pending", async () => {
    let releaseResponse!: () => void;
    mocked.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseResponse = () =>
            resolve(
              Response.json({
                archivedAt: null,
                artifactVersion: 0,
                currentStage: {
                  description: "Build",
                  id: "stage-build",
                  name: "Build",
                  position: 1,
                  slug: "build",
                },
                currentStageId: "stage-build",
                id: session.id,
                phaseStatus: "agent_generating",
                rejectionCount: 0,
                updatedAt: "2026-07-17T12:00:00.000Z",
              }),
            );
        }),
    );

    render(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: makeDetailData(),
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & advance" }));

    expect(screen.getByText("Drafting artifact")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Approving/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();

    await act(async () => releaseResponse());
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Stop run" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("disables optimistic Unarchive while terminal approval is pending", async () => {
    let releaseResponse!: () => void;
    mocked.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseResponse = () =>
            resolve(
              Response.json({
                archivedAt: "2026-07-17T12:00:00.000Z",
                artifactVersion: 1,
                currentStage: {
                  description: "Build",
                  id: "stage-build",
                  name: "Build",
                  position: 1,
                  slug: "build",
                },
                currentStageId: "stage-build",
                id: session.id,
                phaseStatus: "approved",
                rejectionCount: 0,
                updatedAt: "2026-07-17T12:00:00.000Z",
              }),
            );
        }),
    );
    const data = makeDetailData();
    data.session = {
      ...data.session,
      currentStageId: "stage-build",
      currentStageSlug: "build",
    };

    render(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: data,
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & archive" }));

    const unarchive = screen.getByRole("button", { name: "Unarchive" }) as HTMLButtonElement;
    expect(unarchive.disabled).toBe(true);
    expect(mocked.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(unarchive);
    expect(mocked.fetch).toHaveBeenCalledTimes(1);

    await act(async () => releaseResponse());
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Unarchive" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("reconciles the artifact version when Stop races run completion", async () => {
    mocked.fetch.mockResolvedValue(
      Response.json({
        archivedAt: null,
        artifactVersion: 2,
        currentStage: {
          description: "Plan",
          id: "stage-plan",
          name: "Plan",
          position: 0,
          slug: "plan",
        },
        currentStageId: "stage-plan",
        id: session.id,
        phaseStatus: "awaiting_review",
        rejectionCount: 0,
        updatedAt: "2026-07-17T12:00:00.000Z",
      }),
    );
    const data = makeDetailData();
    data.session = {
      ...data.session,
      currentArtifactVersion: 0,
      phaseStatus: "agent_generating",
    };

    render(
      createElement(SessionDetailPageClient, {
        activity: null,
        initialData: data,
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));

    await waitFor(() => expect(screen.getAllByText("Awaiting review")).not.toHaveLength(0));
    expect(screen.getByText("Artifact ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
  });

  it("uses newer archive props when a keyed row survives soft navigation", () => {
    const view = render(
      createElement(SessionsPageClient, { initialData: makeListData(session, "all") }),
    );
    expect(screen.getByRole("link", { name: /Open session #1/ })).toBeTruthy();

    view.rerender(
      createElement(SessionsPageClient, {
        initialData: makeListData(
          {
            ...session,
            archivedAt: "2026-07-17T12:00:00.000Z",
            phaseStatus: "rejected",
            updatedAt: "2026-07-17T12:00:00.000Z",
          },
          "archived",
        ),
      }),
    );

    expect(screen.getByRole("link", { name: /Open session #1/ })).toBeTruthy();
    expect(screen.getByText("Archived", { exact: true })).toBeTruthy();
  });

  it("hides an unarchived row optimistically before the response settles", () => {
    mocked.fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const archived = {
      ...session,
      archivedAt: "2026-07-17T12:00:00.000Z",
      updatedAt: "2026-07-17T12:00:00.000Z",
    };
    render(
      createElement(SessionsPageClient, {
        initialData: makeListData(archived, "archived"),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Unarchive session #1" }));

    expect(screen.queryByRole("link", { name: /Open session #1/ })).toBeNull();
  });

  it("removes an archived row immediately and restores it through the seven-second Undo toast", async () => {
    let releaseArchive!: () => void;
    mocked.fetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseArchive = () =>
              resolve(
                Response.json({
                  archivedAt: "2026-07-17T12:00:00.000Z",
                  id: session.id,
                  phaseStatus: session.phaseStatus,
                  updatedAt: "2026-07-17T12:00:00.000Z",
                }),
              );
          }),
      )
      .mockResolvedValueOnce(
        Response.json({
          archivedAt: null,
          id: session.id,
          phaseStatus: session.phaseStatus,
          updatedAt: "2026-07-17T13:00:00.000Z",
        }),
      );

    render(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPageClient, { initialData: makeListData(session, "all") }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive session #1" }));
    expect(screen.queryByRole("link", { name: /Open session #1/ })).toBeNull();
    expect(screen.getByText("No sessions match these filters")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await act(async () => releaseArchive());
    await waitFor(() => expect(mocked.fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("link", { name: /Open session #1/ })).toBeTruthy());
  });

  it("shows a committed archive after soft navigation to the Archived scope", async () => {
    const archivedAt = "2026-07-17T12:00:00.000Z";
    mocked.fetch.mockResolvedValue(
      Response.json({
        archivedAt,
        id: session.id,
        phaseStatus: session.phaseStatus,
        updatedAt: archivedAt,
      }),
    );
    const view = render(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPageClient, { initialData: makeListData(session, "all") }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive session #1" }));
    await waitFor(() => expect(mocked.fetch).toHaveBeenCalledTimes(1));

    view.rerender(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionsPageClient, {
          initialData: makeListData({ ...session, archivedAt, updatedAt: archivedAt }, "archived"),
        }),
      ),
    );

    expect(screen.getByRole("link", { name: /Open session #1/ })).toBeTruthy();
    expect(screen.getByText("Archived", { exact: true })).toBeTruthy();
  });

  it("ignores an archive Undo after a newer archive replaces its version", async () => {
    mocked.fetch
      .mockResolvedValueOnce(
        Response.json({
          archivedAt: "2026-07-17T12:00:00.000Z",
          id: session.id,
          phaseStatus: session.phaseStatus,
          updatedAt: "2026-07-17T12:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          archivedAt: null,
          id: session.id,
          phaseStatus: session.phaseStatus,
          updatedAt: "2026-07-17T13:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          archivedAt: "2026-07-17T14:00:00.000Z",
          id: session.id,
          phaseStatus: session.phaseStatus,
          updatedAt: "2026-07-17T14:00:00.000Z",
        }),
      );

    render(
      createElement(
        OverlayProvider,
        null,
        createElement(SessionDetailPageClient, {
          activity: null,
          initialData: makeDetailData(),
          initialFormattedArtifact: null,
          initialFormattedArtifactKey: null,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("button", { name: "Unarchive" });
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await screen.findByRole("button", { name: "Archive" });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(mocked.fetch).toHaveBeenCalledTimes(3));

    const undoButtons = await screen.findAllByRole("button", { name: "Undo" });
    fireEvent.click(undoButtons[0]!);

    expect(mocked.fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Archived", { exact: true })).toBeTruthy();
  });

  it("keeps a newer server title when an older save response arrives late", async () => {
    let releaseResponse!: () => void;
    mocked.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseResponse = () =>
            resolve(
              Response.json({
                id: session.id,
                title: "Older saved title",
                updatedAt: "2026-07-17T12:00:00.000Z",
              }),
            );
        }),
    );
    const view = render(
      createElement(SessionsPageClient, { initialData: makeListData(session, "all") }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit title for session #1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session #1 title" }), {
      target: { value: "Older saved title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title for session #1" }));

    view.rerender(
      createElement(SessionsPageClient, {
        initialData: makeListData(
          {
            ...session,
            title: "Newer server title",
            updatedAt: "2026-07-17T13:00:00.000Z",
          },
          "all",
        ),
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Newer server title/ })).toBeTruthy(),
    );
    await act(async () => releaseResponse());
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Newer server title/ })).toBeTruthy(),
    );
    expect(screen.queryByRole("link", { name: /Older saved title/ })).toBeNull();
  });
});
