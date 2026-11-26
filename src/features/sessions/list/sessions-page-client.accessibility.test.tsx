// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { SessionsPage } from "@/features/sessions/list/sessions-page";
import type { SessionListPageData } from "@/features/sessions/list/data";

const mocked = vi.hoisted(() => ({
  destructiveConfirmationDialogRender: vi.fn(),
  push: vi.fn(),
  prefetch: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/components/ui/destructive-confirmation-dialog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ui/destructive-confirmation-dialog")>();
  return {
    ...actual,
    DestructiveConfirmationDialog: (
      props: ComponentProps<typeof actual.DestructiveConfirmationDialog>,
    ) => {
      mocked.destructiveConfirmationDialogRender(props);
      return <actual.DestructiveConfirmationDialog {...props} />;
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocked.push,
    prefetch: mocked.prefetch,
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
      latestRunStatus: null,
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
  scopeFacets: { active: 1, all: 1, archived: 0 },
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
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  mocked.destructiveConfirmationDialogRender.mockReset();
  mocked.push.mockReset();
  mocked.refresh.mockReset();
  mocked.replace.mockReset();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("SessionsPage accessibility", () => {
  it("labels Search, scope radios, Stage, Status, Sort, and Clear with selected semantics", async () => {
    const user = userEvent.setup();
    render(
      <OverlayProvider>
        <main>
          <SessionsPage initialData={initialData} />
        </main>
      </OverlayProvider>,
    );

    expect(screen.getByRole("radiogroup", { name: "Session scope" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Not archived 1" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const stageCombo = screen.getByRole("combobox", { name: "Filter by stage" });
    expect(stageCombo).toBeInTheDocument();
    expect(stageCombo).toHaveTextContent("Build");
    expect(screen.getByRole("combobox", { name: "Filter by status" })).toHaveTextContent(
      "All statuses",
    );
    expect(screen.getByRole("combobox", { name: "Sort sessions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();

    const search = screen.getByRole("searchbox", {
      name: "Search sessions by title, prompt, session number, or Linear issue key",
    });
    expect(search).toHaveAccessibleDescription("Title, prompt, session #42, or Linear OP-517");
    await user.type(search, "OP-339{Enter}");
    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions?stage=build&q=OP-339", {
      scroll: false,
    });

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions", { scroll: false });
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();

    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders Active as the clear-free default scope", () => {
    render(
      <OverlayProvider>
        <main>
          <SessionsPage
            initialData={{
              ...initialData,
              queryState: { ...initialData.queryState, stageSlug: null },
            }}
          />
        </main>
      </OverlayProvider>,
    );

    expect(screen.getByRole("radio", { name: "Not archived 1" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
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
          <SessionsPage initialData={dataWithQuery} />
        </main>
      </OverlayProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions", { scroll: false });

    rerender(
      <OverlayProvider>
        <main>
          <SessionsPage
            initialData={{
              ...dataWithQuery,
              queryState: {
                ...dataWithQuery.queryState,
                query: "",
                scope: "active",
                stageSlug: null,
              },
            }}
          />
        </main>
      </OverlayProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("searchbox", {
          name: "Search sessions by title, prompt, session number, or Linear issue key",
        }),
      ).toHaveFocus(),
    );
  });

  it("keeps every status scope addressable and resets cursors on navigation", async () => {
    const user = userEvent.setup();
    render(
      <OverlayProvider>
        <main>
          <SessionsPage
            initialData={{
              ...initialData,
              queryState: {
                cursor: "stale-cursor",
                query: "OP-339",
                scope: "active",
                sort: "oldest",
                stageSlug: "build",
              },
            }}
          />
        </main>
      </OverlayProvider>,
    );

    await user.click(screen.getByRole("radio", { name: "Archived 0" }));
    expect(mocked.push).toHaveBeenLastCalledWith(
      "/w/acme/sessions?stage=build&q=OP-339&scope=archived&sort=oldest",
      { scroll: false },
    );

    await user.click(screen.getByRole("radio", { name: "All sessions 1" }));
    expect(mocked.push).toHaveBeenLastCalledWith(
      "/w/acme/sessions?stage=build&q=OP-339&scope=all&sort=oldest",
      { scroll: false },
    );

    await user.click(screen.getByRole("radio", { name: "Not archived 1" }));
    expect(mocked.push).toHaveBeenLastCalledWith(
      "/w/acme/sessions?stage=build&q=OP-339&sort=oldest",
      { scroll: false },
    );
  });

  it("lazily mounts archive AlertDialog on demand, restores focus on cancel, confirms, and passes axe", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(
      <OverlayProvider>
        <main>
          <SessionsPage initialData={initialData} />
        </main>
      </OverlayProvider>,
    );

    expect(mocked.destructiveConfirmationDialogRender).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    const trigger = screen.getByRole("button", { name: "Actions for session #339" });
    await user.click(trigger);
    expect(await screen.findByRole("menu", { name: "Actions for session #339" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    expect(
      screen.getByRole("menuitem", { name: "Archive session" }).querySelector("svg"),
    ).not.toBeNull();
    expect(mocked.destructiveConfirmationDialogRender).not.toHaveBeenCalled();

    await user.keyboard("{End}{Enter}");
    expect(screen.queryByRole("menu", { name: "Actions for session #339" })).toBeNull();
    expect(mocked.destructiveConfirmationDialogRender).toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Archive session" })).toBeVisible();

    const openDialogAxe = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(openDialogAxe.violations).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mocked.destructiveConfirmationDialogRender).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: false }),
    );

    const closedDialogAxe = await axe.run(screen.getByRole("main"), {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(closedDialogAxe.violations).toEqual([]);

    await user.click(trigger);
    expect(await screen.findByRole("menu", { name: "Actions for session #339" })).toBeVisible();
    await user.keyboard("{End}{Enter}");
    expect(await screen.findByRole("alertdialog")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Archive session" }));
    expect(screen.queryByRole("link", { name: /Open session #339/ })).toBeNull();
    expect(screen.getByText("Archiving session #339…", { exact: true })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());

    const pendingArchiveAxe = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(pendingArchiveAxe.violations).toEqual([]);
  });

  it("shows a page-local fallback when a local archive hides the last row", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(
      <OverlayProvider>
        <main>
          <SessionsPage
            initialData={{
              ...initialData,
              queryState: { ...initialData.queryState, stageSlug: null },
            }}
          />
        </main>
      </OverlayProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Actions for session #339" });
    await user.click(trigger);
    expect(await screen.findByRole("menu", { name: "Actions for session #339" })).toBeVisible();
    await user.keyboard("{End}{Enter}");
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Archive session" }));

    expect(await screen.findByText("No sessions on this page")).toBeVisible();
    expect(screen.getByRole("link", { name: "View all sessions" })).toHaveAttribute(
      "href",
      "/w/acme/sessions?scope=all",
    );
    expect(screen.queryByText("No sessions yet")).toBeNull();
    expect(screen.queryByText("No unarchived sessions")).toBeNull();
    expect(screen.queryByRole("link", { name: /New session/ })).toBeNull();
  });

  it("renders ledger columns and keeps only the title as the detail link", () => {
    render(
      <OverlayProvider>
        <main>
          <SessionsPage initialData={initialData} />
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
    expect(screen.getAllByText("acme/wallie").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".sessions-ledger-cell-repository")).toHaveTextContent(
      "acme/wallie",
    );
    const detailHref = new URL(
      (screen.getByRole("link", { name: /Open session #339/ }) as HTMLAnchorElement).href,
    );
    expect(detailHref.pathname).toBe("/w/acme/sessions/339");
    expect(detailHref.searchParams.get("returnTo")).toBe(
      "/w/acme/sessions?stage=build&scope=active",
    );
    expect(screen.queryByRole("link", { name: /Archive/ })).toBeNull();
  });

  it("widens an empty filtered search on the same term, even when a stage has no matches", () => {
    render(
      <OverlayProvider>
        <SessionsPage
          factoryName="Payments"
          factoryQuery="payments-id"
          initialData={{
            ...initialData,
            sessions: [],
            queryState: { ...initialData.queryState, query: "#42", status: "failed" },
            stageFacets: [{ count: 0, name: "Build", position: 1, slug: "build" }],
          }}
        />
      </OverlayProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Filter by stage" })).toHaveTextContent("Build");
    expect(screen.getByRole("combobox", { name: "Filter by status" })).toHaveTextContent("Failed");
    expect(screen.getByText("Scope: Payments · Not archived")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Search all sessions in accessible factories" }),
    ).toHaveAttribute("href", "/w/acme/sessions?q=%2342&scope=all&factory=all");
  });

  it("retains all applied filters and the cursor in the detail return link", () => {
    render(
      <OverlayProvider>
        <SessionsPage
          factoryId="default-id"
          initialData={{
            ...initialData,
            queryState: {
              cursor: "cursor-2",
              query: "#42 & release",
              scope: "all",
              sort: "number",
              stageSlug: "build",
              status: "awaiting_review",
            },
          }}
        />
      </OverlayProvider>,
    );
    const detail = screen.getByRole("link", { name: /Open session #339/ }) as HTMLAnchorElement;
    const href = new URL(
      new URL(detail.href).searchParams.get("returnTo")!,
      window.location.origin,
    );
    expect(href.pathname).toBe("/w/acme/sessions");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      cursor: "cursor-2",
      factory: "default-id",
      q: "#42 & release",
      scope: "all",
      sort: "number",
      stage: "build",
      status: "awaiting_review",
    });
    expect(screen.getByText("Later page · 1 session")).toBeVisible();
    const first = screen.getByRole("link", { name: "Back to first page" }) as HTMLAnchorElement;
    href.searchParams.delete("cursor");
    expect(new URL(first.href).searchParams.toString()).toBe(href.searchParams.toString());
  });

  it("restores title-link focus when inline rename is canceled", async () => {
    const user = userEvent.setup();
    render(
      <OverlayProvider>
        <SessionsPage initialData={initialData} />
      </OverlayProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Actions for session #339" }));
    await user.keyboard("{Home}{Enter}");
    expect(screen.getByRole("textbox", { name: "Session #339 title" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("link", { name: /Open session #339/ })).toHaveFocus();
  });
});
