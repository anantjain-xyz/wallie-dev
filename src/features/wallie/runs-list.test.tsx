// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import { RunsList } from "@/features/wallie/runs-list";
import {
  parseRunsListQuery,
  runCatalogActivityLabel,
  runCatalogCostLabel,
  runListReturn,
  runsListPageHref,
} from "@/features/wallie/runs-list-state";
import { parseRunFailure } from "@/lib/pipeline/run-failure";

const mocked = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocked }));

const SESSION_ID = "b0000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "a0000000-0000-4000-8000-000000000001";
const FACTORY_ID = "a0000000-0000-4000-8000-000000000002";
const STAGE_ID = "c0000000-0000-4000-8000-000000000001";
const RUN_ID = "d0000000-0000-4000-8000-000000000001";
const now = "2026-11-14T21:00:00.000Z";
const run: WorkspaceRunCatalogItem = {
  id: RUN_ID,
  factoryId: FACTORY_ID,
  sessionId: SESSION_ID,
  sessionNumber: 42,
  sessionTitle: "Improve sign-in reliability",
  sessionRunHref: `/w/acme/sessions/42#wallie-run-${RUN_ID}`,
  attemptCount: 1,
  stageOrdinal: 2,
  newerRunId: null,
  stageId: STAGE_ID,
  stageName: "Build",
  modelProvider: "codex",
  modelName: "gpt-5.6",
  status: "success",
  interrupted: false,
  failure: null,
  createdAt: "2026-11-14T20:55:00.000Z",
  startedAt: "2026-11-14T20:55:00.000Z",
  finishedAt: "2026-11-14T20:58:00.000Z",
  lastActivityAt: "2026-11-14T20:58:00.000Z",
  usage: {
    inputTokens: null,
    outputTokens: null,
    totalCostUsd: null,
    tokenProvenance: "unavailable",
    costProvenance: "unavailable",
    finalized: true,
  },
  transcript: {
    expiredAt: null,
    hasEvents: true,
    captureEnded: true,
    captureInterrupted: false,
  },
  recovery: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Runs list", () => {
  it("keeps the scoped Sessions recovery only in the unfiltered empty state", () => {
    render(
      <RunsList
        factoryQuery={FACTORY_ID}
        initialNow={now}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: {},
          state: { kind: "ready", page: { runs: [], nextCursor: null } },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
    expect(screen.queryByRole("link", { name: "← Sessions" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View sessions" })).toHaveAttribute(
      "href",
      `/w/acme/sessions?factory=${FACTORY_ID}`,
    );
  });

  it("links distinct attempts to inspectors and keeps the session activity link", () => {
    const earlier = {
      ...run,
      id: "d0000000-0000-4000-8000-000000000002",
      attemptCount: 1,
      stageOrdinal: 1,
      status: "error" as const,
    };
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: {},
          state: { kind: "ready", page: { runs: [run, earlier], nextCursor: null } },
        }}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: "Inspect run for session 42, Build, attempt 2" })
        .getAttribute("href"),
    ).toBe(`/w/acme/runs/${RUN_ID}`);
    expect(
      screen
        .getByRole("link", { name: "Inspect run for session 42, Build, attempt 1" })
        .getAttribute("href"),
    ).toBe(`/w/acme/runs/${earlier.id}`);
    expect(screen.getAllByRole("link", { name: "#42" })[0]?.getAttribute("href")).toBe(
      run.sessionRunHref,
    );
    expect(screen.getByText("2 runs on this page")).toBeTruthy();
    expect(screen.getAllByText("Cost unavailable")).toHaveLength(2);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("preserves filters in older/latest links and pushes a new filtered page without its old cursor", () => {
    render(
      <RunsList
        initialNow={now}
        factoryQuery="all"
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: {
            cursor: "previous",
            status: "error",
            provider: "codex",
            sessionId: SESSION_ID,
            stageId: STAGE_ID,
          },
          state: { kind: "ready", page: { runs: [run], nextCursor: "next_page" } },
        }}
      />,
    );
    const older = new URL(
      screen.getByRole("link", { name: "Older runs →" }).getAttribute("href") ?? "",
      "http://localhost",
    );
    expect(Object.fromEntries(older.searchParams)).toEqual({
      cursor: "next_page",
      status: "error",
      provider: "codex",
      sessionId: SESSION_ID,
      stageId: STAGE_ID,
      factory: "all",
    });
    const latest = screen.getByRole("link", { name: "Back to latest" }).getAttribute("href");
    expect(latest).toContain("status=error");
    expect(latest).not.toContain("cursor=");

    const inspectorLinks = [
      screen.getByRole("link", { name: /Improve sign-in reliability/ }),
      screen.getByRole("link", { name: "Inspect run for session 42, Build, attempt 2" }),
    ];
    for (const link of inspectorLinks) {
      const inspector = new URL(link.getAttribute("href")!, "https://wallie.test");
      expect(inspector.pathname).toBe(`/w/acme/runs/${RUN_ID}`);
      const back = runListReturn("acme", inspector.searchParams.get("fromRuns")!);
      expect(back?.label).toBe("Back to filtered runs");
      expect(Object.fromEntries(new URL(back!.href, "https://wallie.test").searchParams)).toEqual({
        cursor: "previous",
        status: "error",
        provider: "codex",
        sessionId: SESSION_ID,
        stageId: STAGE_ID,
        factory: "all",
      });
    }

    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "Canceled" }));
    fireEvent.submit(screen.getByRole("form", { name: "Filter runs" }));
    expect(mocked.push).toHaveBeenCalledTimes(1);
    const destination = new URL(mocked.push.mock.calls[0]?.[0], "http://localhost");
    expect(Object.fromEntries(destination.searchParams)).toEqual({
      status: "canceled",
      provider: "codex",
      sessionId: SESSION_ID,
      stageId: STAGE_ID,
      factory: "all",
    });
    expect(screen.getByRole("link", { name: "Clear" }).getAttribute("href")).toBe(
      "/w/acme/runs?factory=all",
    );
  });

  it("keeps active session/stage filters even when no rows are available", () => {
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: { sessionId: SESSION_ID, stageId: STAGE_ID },
          sessionOption: { id: SESSION_ID, label: "#42 Improve sign-in reliability" },
          stages: [{ id: STAGE_ID, label: "Build (archived) · Release" }],
          state: { kind: "ready", page: { runs: [], nextCursor: null } },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "No matching runs" })).toBeTruthy();
    const sessionFilter = screen.getByRole("combobox", { name: "Session" }) as HTMLInputElement;
    expect(sessionFilter.value).toBe("#42 Improve sign-in reliability");
    expect(screen.getByRole("combobox", { name: "Stage" }).textContent).toContain(
      "Build (archived) · Release",
    );
    fireEvent.submit(screen.getByRole("form", { name: "Filter runs" }));
    expect(mocked.push).toHaveBeenCalledWith(
      `/w/acme/runs?sessionId=${SESSION_ID}&stageId=${STAGE_ID}`,
    );
  });

  it.each(["reliability", "#42"])(
    "searches a factory for %s beyond the current page",
    async (query) => {
      const fetch = vi.fn(async () =>
        Response.json([{ id: SESSION_ID, label: "#42 Improve sign-in reliability" }]),
      );
      vi.stubGlobal("fetch", fetch);
      render(
        <RunsList
          initialNow={now}
          factoryQuery={FACTORY_ID}
          data={{
            workspaceId: WORKSPACE_ID,
            workspaceSlug: "acme",
            query: { status: "error" },
            state: { kind: "ready", page: { runs: [], nextCursor: null } },
          }}
        />,
      );
      const input = screen.getByRole("combobox", { name: "Session" }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: query } });
      await screen.findByRole("option", { name: "#42 Improve sign-in reliability" });
      expect(fetch).toHaveBeenCalledWith(
        `/api/workspaces/${WORKSPACE_ID}/runs/session-options?${new URLSearchParams({ factory: FACTORY_ID, q: query })}`,
        expect.anything(),
      );
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.value).toBe("#42 Improve sign-in reliability");
      fireEvent.submit(screen.getByRole("form", { name: "Filter runs" }));
      const destination = new URL(mocked.push.mock.calls[0]?.[0], "https://wallie.test");
      expect(Object.fromEntries(destination.searchParams)).toEqual({
        status: "error",
        factory: FACTORY_ID,
        sessionId: SESSION_ID,
      });
    },
  );

  it.each(["matches", "no matches"] as const)(
    "can explicitly select Any session by keyboard after a search with %s",
    async (outcome) => {
      const selected = { id: SESSION_ID, label: "#42 Improve sign-in reliability" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(outcome === "matches" ? [selected] : [])),
      );
      render(
        <RunsList
          initialNow={now}
          factoryQuery={FACTORY_ID}
          data={{
            workspaceId: WORKSPACE_ID,
            workspaceSlug: "acme",
            query: { status: "error", sessionId: SESSION_ID },
            sessionOption: selected,
            state: { kind: "ready", page: { runs: [], nextCursor: null } },
          }}
        />,
      );
      const input = screen.getByRole("combobox", { name: "Session" }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "reliability" } });
      if (outcome === "matches") {
        await screen.findByRole("option", { name: selected.label });
      } else {
        await screen.findByText("No matching sessions.");
        fireEvent.keyDown(input, { key: "Enter" });
        expect(input.value).toBe("reliability");
      }
      fireEvent.keyDown(input, { key: "ArrowUp" });
      const clearOption = screen.getByRole("option", { name: "Any session" });
      expect(clearOption).toHaveAttribute("data-highlighted");
      expect(clearOption).toHaveAttribute("aria-selected", "false");
      expect(input).toHaveAttribute("aria-activedescendant", clearOption.id);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.value).toBe("Any session");
      fireEvent.submit(screen.getByRole("form", { name: "Filter runs" }));
      const destination = new URL(mocked.push.mock.calls[0]?.[0], "https://wallie.test");
      expect(Object.fromEntries(destination.searchParams)).toEqual({
        status: "error",
        factory: FACTORY_ID,
      });
    },
  );

  it("keeps focus on the input and only applies a committed choice from the portaled listbox", async () => {
    const user = userEvent.setup();
    const selected = { id: SESSION_ID, label: "#42 Improve sign-in reliability" };
    const other = {
      id: "b0000000-0000-4000-8000-000000000002",
      label: "#43 Check release logs",
      factoryName: "Release lab",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([selected, other])),
    );
    render(
      <PortalRootProvider>
        <RunsList
          initialNow={now}
          factoryQuery="all"
          data={{
            workspaceId: WORKSPACE_ID,
            workspaceSlug: "acme",
            query: {
              sessionId: SESSION_ID,
              status: "error",
              cursor: "previous",
              limit: 20,
              agentId: RUN_ID,
              agentPromptRevisionId: STAGE_ID,
            },
            sessionOption: selected,
            state: { kind: "ready", page: { runs: [], nextCursor: null } },
          }}
        />
      </PortalRootProvider>,
    );
    const form = screen.getByRole<HTMLFormElement>("form", { name: "Filter runs" });
    const input = screen.getByRole("combobox", { name: "Session" });
    await user.click(input);
    const match = await screen.findByRole("option", {
      name: /#43 Check release logs.*Release lab/,
    });
    const listbox = screen.getByRole("listbox", { name: "Session matches" });
    expect(listbox.closest("[data-wallie-overlay-root]")).not.toBeNull();
    expect(listbox.closest(".ui-select-content")).not.toBeNull();
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    const committed = screen.getByRole("option", { name: selected.label });
    expect(committed).toHaveAttribute("aria-selected", "true");
    expect(committed.querySelector("svg")).toBeInTheDocument();
    await user.hover(match);
    expect(match).toHaveAttribute("data-highlighted");
    expect(match).toHaveAttribute("aria-selected", "false");
    expect(input).toHaveAttribute("aria-activedescendant", match.id);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(new FormData(form).get("sessionId")).toBe(SESSION_ID);
    expect(listbox).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(input).toHaveFocus();
    expect(input).toHaveValue(selected.label);
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(listbox).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    await user.click(await screen.findByRole("option", { name: /Check release logs/ }));
    expect(input).toHaveFocus();
    expect(input).toHaveValue(other.label);
    expect(new FormData(form).get("sessionId")).toBe(other.id);
    expect(mocked.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Apply" }));
    const destination = new URL(mocked.push.mock.calls[0]?.[0], "https://wallie.test");
    expect(Object.fromEntries(destination.searchParams)).toEqual({
      status: "error",
      factory: "all",
      sessionId: other.id,
      limit: "20",
      agentId: RUN_ID,
      agentPromptRevisionId: STAGE_ID,
    });
  });

  it("debounces and aborts search, ignores superseded results, and keeps an unavailable ID on error", async () => {
    vi.useFakeTimers();
    const stale = Promise.withResolvers<Response>();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: { sessionId: SESSION_ID },
          state: { kind: "ready", page: { runs: [], nextCursor: null } },
        }}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Session" });
    expect(input).toHaveValue("Session unavailable");
    fireEvent.change(input, { target: { value: "  first  " } });
    expect(screen.getByText("Searching sessions…")).toBeInTheDocument();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(179));
    expect(fetch).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledWith(
      `/api/workspaces/${WORKSPACE_ID}/runs/session-options?factory=all&q=first`,
      { cache: "no-store", signal: expect.any(AbortSignal) },
    );
    fireEvent.change(input, { target: { value: "second" } });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      stale.resolve(Response.json([{ id: SESSION_ID, label: "Stale session" }]));
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(screen.queryByRole("option", { name: "Stale session" })).not.toBeInTheDocument();
    expect(screen.getByText(/Couldn’t load sessions/)).toBeInTheDocument();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);

    fireEvent.change(input, { target: { value: "third" } });
    await act(() => vi.advanceTimersByTimeAsync(180));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(fetch.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    expect(input).toHaveValue("Session unavailable");
    expect(screen.queryByRole("listbox", { name: "Session matches" })).not.toBeInTheDocument();
    const form = screen.getByRole<HTMLFormElement>("form", { name: "Filter runs" });
    expect(new FormData(form).get("sessionId")).toBe(SESSION_ID);
  });

  it("clears only the unavailable selection and restarts pagination", () => {
    render(
      <RunsList
        initialNow={now}
        factoryQuery={FACTORY_ID}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: { cursor: "previous", status: "error", sessionId: SESSION_ID, stageId: STAGE_ID },
          state: { kind: "ready", page: { runs: [], nextCursor: null } },
        }}
      />,
    );
    const href = screen
      .getByRole("link", { name: "Clear unavailable session" })
      .getAttribute("href");
    expect(Object.fromEntries(new URL(href!, "https://wallie.test").searchParams)).toEqual({
      factory: FACTORY_ID,
      status: "error",
      stageId: STAGE_ID,
    });
  });

  it("shows an allowlisted cause and the queued retry time on a failed row", () => {
    const retryAt = "2026-11-14T21:04:00.000Z";
    const failed: WorkspaceRunCatalogItem = {
      ...run,
      status: "error",
      failure: parseRunFailure(
        '{"version":1,"code":"budget","category":"budget","text":"private details"}',
      ),
      recovery: {
        metadataAvailable: true,
        queue: {
          state: "retry_scheduled",
          status: "queued",
          attemptCount: 1,
          scheduledAt: retryAt,
        },
        publication: null,
        sourceRecoveryRequired: false,
        retryCheckpointAvailable: false,
        activity: { state: "unknown", observedAt: now, thresholdMs: 900_000 },
        worker: {
          state: "unobserved",
          deadlineAt: null,
          dispatchedAt: null,
          executionStartedAt: null,
        },
      },
    };
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: { status: "error" },
          state: { kind: "ready", page: { runs: [failed], nextCursor: null } },
        }}
      />,
    );
    expect(screen.getByText("Execution limit")).toBeTruthy();
    expect(screen.getByText(/Retry scheduled/).querySelector("time")?.dateTime).toBe(retryAt);
    expect(screen.queryByText(/private details/)).toBeNull();
  });

  it("shows a useful first-run empty state and a sessions return", () => {
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: {},
          state: { kind: "ready", page: { runs: [], nextCursor: null } },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "No runs yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View sessions" }).getAttribute("href")).toBe(
      "/w/acme/sessions",
    );
  });

  it("offers a safe restart for an invalid cursor without silently dropping filters", () => {
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: { cursor: "invalid", status: "error" },
          state: { kind: "invalid-cursor" },
        }}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Latest runs" }).getAttribute("href")).toBe(
      "/w/acme/runs?status=error",
    );
  });

  it("refreshes failed reads and does not present an error as an empty catalog", () => {
    render(
      <RunsList
        initialNow={now}
        data={{
          workspaceId: WORKSPACE_ID,
          workspaceSlug: "acme",
          query: {},
          state: { kind: "error" },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Runs couldn’t load" })).toBeTruthy();
    expect(screen.queryByText("No runs yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocked.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("Runs list state", () => {
  it("accepts blank GET form fields but rejects malformed or repeated filters", () => {
    expect(parseRunsListQuery({ provider: "", status: "error", limit: "20" })).toMatchObject({
      success: true,
      data: { status: "error", limit: 20 },
    });
    expect(parseRunsListQuery({ status: ["error", "success"] }).success).toBe(false);
    expect(parseRunsListQuery({ sessionId: "not-a-session" }).success).toBe(false);
    expect(parseRunsListQuery({ limit: "1000" }).success).toBe(false);
    expect(parseRunsListQuery({ agentId: SESSION_ID }).success).toBe(false);
    expect(runListReturn("acme", "next=https://elsewhere.test")).toBeUndefined();
    expect(runListReturn("acme", "factory=all&factory=elsewhere")).toBeUndefined();
  });

  it("keeps opaque cursors unchanged across navigable URLs", () => {
    const cursor = "abc_def-123";
    expect(runsListPageHref("acme", { provider: "cursor", limit: 20 }, cursor)).toBe(
      `/w/acme/runs?provider=cursor&limit=20&cursor=${cursor}`,
    );
  });

  it("distinguishes unavailable, pending and interrupted capture", () => {
    expect(
      runCatalogActivityLabel({ ...run, transcript: { ...run.transcript, hasEvents: false } }),
    ).toBe("Activity unavailable");
    expect(
      runCatalogActivityLabel({
        ...run,
        status: "running",
        transcript: { ...run.transcript, hasEvents: false },
      }),
    ).toBe("No activity yet");
    expect(
      runCatalogActivityLabel({ ...run, transcript: { ...run.transcript, captureEnded: false } }),
    ).toBe("Capture incomplete");
    expect(
      runCatalogActivityLabel({
        ...run,
        transcript: { ...run.transcript, captureInterrupted: true },
      }),
    ).toBe("Capture interrupted");
    expect(
      runCatalogActivityLabel({
        ...run,
        status: "running",
        transcript: { ...run.transcript, captureEnded: false },
      }),
    ).toBe("Structured activity");
  });

  it("distinguishes measured zero, estimates and unavailable cost", () => {
    expect(runCatalogCostLabel(run)).toBe("Cost unavailable");
    expect(
      runCatalogCostLabel({
        ...run,
        usage: { ...run.usage, totalCostUsd: 0, costProvenance: "measured" },
      }),
    ).toBe("$0.00 measured");
    expect(
      runCatalogCostLabel({
        ...run,
        usage: { ...run.usage, totalCostUsd: 0.25, costProvenance: "estimated" },
      }),
    ).toBe("$0.25 estimated");
  });
});
