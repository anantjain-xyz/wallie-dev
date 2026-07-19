// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { SessionsPageClient } from "@/features/sessions/list/sessions-page-client";
import type { SessionListPageData } from "@/features/sessions/list/data";

const mocked = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocked.push,
    refresh: mocked.refresh,
    replace: mocked.replace,
  }),
}));

const initialData: SessionListPageData = {
  hasAnySession: true,
  hasMore: false,
  nextCursor: null,
  onboarding: null,
  queryState: {
    cursor: null,
    query: "",
    scope: "active",
    sort: "updated",
    stageSlug: "build",
  },
  sessions: [
    {
      archivedAt: null,
      createdAt: "2026-07-18T10:00:00.000Z",
      currentArtifactVersion: 1,
      currentStageId: "stage-build",
      currentStageName: "Build",
      currentStagePosition: 1,
      currentStageSlug: "build",
      id: "00000000-0000-4000-8000-000000000001",
      linearIssueId: "OP-339",
      linearIssueUrl: null,
      number: 339,
      phaseStatus: "awaiting_review",
      pipelineId: "pipeline-default",
      pullRequestCount: 0,
      pullRequests: [],
      rejectionCount: 0,
      repositoryFullName: "acme/wallie",
      title: "Label forms and filters",
      updatedAt: "2026-07-18T11:00:00.000Z",
      workspaceId: "00000000-0000-4000-8000-000000000002",
    },
  ],
  stageFacets: [{ count: 1, name: "Build", position: 1, slug: "build" }],
  totalCount: 1,
  workspace: {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Acme",
    slug: "acme",
  },
};

beforeEach(() => {
  class ResizeObserverStub {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  mocked.push.mockReset();
  mocked.refresh.mockReset();
  mocked.replace.mockReset();
  vi.unstubAllGlobals();
});

describe("SessionsPageClient accessibility", () => {
  it("labels Search, Status, Stage, Sort, and Clear with selected semantics", async () => {
    const user = userEvent.setup();
    render(
      <OverlayProvider>
        <main>
          <SessionsPageClient initialData={initialData} />
        </main>
      </OverlayProvider>,
    );

    expect(screen.getByRole("group", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Stage" })).toBeInTheDocument();
    expect(screen.getByText("Sort")).toBeInTheDocument();
    expect(screen.getByText("Clear")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active", pressed: true })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Build, 1 session", pressed: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All", pressed: false })).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search" });
    await user.type(search, "OP-339{Enter}");
    expect(mocked.push).toHaveBeenLastCalledWith(
      "/w/acme/sessions?stage=build&q=OP-339&scope=active",
    );

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions");
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();

    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("restores Search focus after Clear navigation remounts the keyed input", async () => {
    const user = userEvent.setup();
    const dataWithQuery: SessionListPageData = {
      ...initialData,
      queryState: { ...initialData.queryState, query: "OP-339" },
    };
    const { rerender } = render(
      <OverlayProvider>
        <main>
          <SessionsPageClient initialData={dataWithQuery} />
        </main>
      </OverlayProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions");

    rerender(
      <OverlayProvider>
        <main>
          <SessionsPageClient
            initialData={{
              ...dataWithQuery,
              queryState: { ...dataWithQuery.queryState, query: "", scope: "all", stageSlug: null },
            }}
          />
        </main>
      </OverlayProvider>,
    );

    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search" })).toHaveFocus());
  });

  it("confirms archive via AlertDialog from the keyboard and announces pending state", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(
      <OverlayProvider>
        <main>
          <SessionsPageClient initialData={initialData} />
        </main>
      </OverlayProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Actions for session #339" });
    await user.click(trigger);
    expect(await screen.findByRole("menu", { name: "Actions for session #339" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();

    await user.keyboard("{End}{Enter}");
    expect(screen.queryByRole("menu", { name: "Actions for session #339" })).toBeNull();
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Archive session" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Archive session" }));
    expect(screen.queryByRole("link", { name: /Open session #339/ })).toBeNull();
    expect(screen.getByText("Archiving session #339…", { exact: true })).toBeVisible();
  });

  it("renders ledger columns and keeps only the title as the detail link", () => {
    render(
      <OverlayProvider>
        <main>
          <SessionsPageClient initialData={initialData} />
        </main>
      </OverlayProvider>,
    );

    expect(screen.getByRole("table", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((node) => node.textContent)).toEqual([
      "Session",
      "Stage",
      "Status",
      "Repository",
      "Updated",
      "Actions",
    ]);
    expect(screen.getByText("acme/wallie")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open session #339/ })).toHaveAttribute(
      "href",
      "/w/acme/sessions/339",
    );
    expect(screen.queryByRole("link", { name: /Archive/ })).toBeNull();
  });
});
