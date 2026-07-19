// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionWalliePanel } from "@/features/wallie/session-wallie-panel";
import type { WallieRun, WallieSessionData } from "@/features/wallie/types";
import type { WorkspaceMember } from "@/features/workspace-members/types";
import type { Database } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

const offlineMember: WorkspaceMember = {
  avatarUrl: null,
  fullName: "Riley Offline",
  id: "member-offline",
  isActive: true,
  kind: "human",
  role: "member",
  userId: "user-offline",
  username: "riley",
};

function run(index: number, overrides: Partial<WallieRun> = {}): WallieRun {
  const id = `run-${index}`;
  return {
    attemptCount: 1,
    canCancel: false,
    canRetry: false,
    createdAt: `2026-07-18T12:${(59 - index).toString().padStart(2, "0")}:00.000Z`,
    finishedAt: "2026-07-18T13:00:00.000Z",
    id,
    isActive: false,
    isTerminal: true,
    lastActivityAt: "2026-07-18T13:00:00.000Z",
    messages: [],
    modelName: "gpt-5",
    modelProvider: "codex",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "code",
    sandboxId: null,
    sandboxProvider: null,
    startedAt: "2026-07-18T12:00:00.000Z",
    stageId: null,
    stageName: `Stage ${index}`,
    stageSlug: `stage-${index}`,
    status: "success",
    updatedAt: "2026-07-18T13:00:00.000Z",
    ...overrides,
  };
}

function data(
  runs: WallieRun[],
  hasOlder = false,
  overrides: Partial<WallieSessionData> = {},
): WallieSessionData {
  return {
    blockingReasons: [],
    canEnqueue: true,
    loadedMessageRunIds: [],
    missingSecretKeys: [],
    mode: "code",
    nextRunCursor: hasOlder
      ? {
          createdAt: runs.at(-1)?.createdAt ?? "2026-07-18T12:00:00.000Z",
          id: runs.at(-1)?.id ?? "run-20",
        }
      : null,
    repository: {
      defaultBranch: "main",
      defaultProgrammingLanguage: "TypeScript",
      fullName: "acme/wallie",
      htmlUrl: "https://github.com/acme/wallie",
      id: "repository-1",
      isArchived: false,
      isPrivate: true,
    },
    requiredSecretKeys: [],
    requiresVercelSandbox: false,
    runs,
    stallTimeoutMs: 900_000,
    vercelSandboxConnection: {
      connected: false,
      lastValidationError: null,
      projectId: null,
      projectName: null,
      status: "missing",
      teamId: null,
    },
    workspaceMembers: [],
    ...overrides,
  };
}

type ChangeCallback = (payload: { eventType: string; new: unknown }) => void;

function fakeSupabase(messages: Record<string, Array<Record<string, string>>> = {}) {
  const activeChannels = new Set<FakeChannel>();
  const channels: FakeChannel[] = [];
  const messageQueries: string[] = [];

  class FakeChannel {
    changeCallback: ChangeCallback | null = null;
    statusCallback: ((status: string) => void) | null = null;

    constructor(readonly name: string) {}

    on(_event: string, _config: unknown, callback: ChangeCallback) {
      this.changeCallback = callback;
      return this;
    }

    subscribe(callback?: (status: string) => void) {
      this.statusCallback = callback ?? null;
      activeChannels.add(this);
      return this;
    }
  }

  const supabase = {
    channel: vi.fn((name: string) => {
      const channel = new FakeChannel(name);
      channels.push(channel);
      return channel;
    }),
    from: vi.fn(() => ({
      select: () => ({
        eq: (_column: string, runId: string) => ({
          order: async () => {
            messageQueries.push(runId);
            return { data: messages[runId] ?? [], error: null };
          },
        }),
      }),
    })),
    removeChannel: vi.fn(async (channel: FakeChannel) => {
      activeChannels.delete(channel);
      return "ok";
    }),
  };

  return {
    activeChannels,
    channels,
    messageQueries,
    supabase: supabase as unknown as SupabaseClient<Database>,
  };
}

let idleCallback: (() => void) | null;

beforeEach(() => {
  idleCallback = null;
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 1;
    }),
  });
  Object.defineProperty(window, "cancelIdleCallback", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function panel(initialData: WallieSessionData, supabase: SupabaseClient<Database>) {
  return render(
    <SessionWalliePanel
      initialData={initialData}
      session={{ archivedAt: null, id: "session-1", workspaceId: "workspace-1" }}
      supabase={supabase}
      workspaceSlug="acme"
    />,
  );
}

describe("SessionWalliePanel run history lifecycle", () => {
  it("bounds the initial DOM/channels, lazily caches one expanded run, and pages explicitly", async () => {
    const initialRuns = Array.from({ length: 20 }, (_, index) => run(index + 1));
    const olderRuns = Array.from({ length: 20 }, (_, index) => run(index + 21));
    const fake = fakeSupabase({
      "run-1": [
        {
          agent_run_id: "run-1",
          created_at: "2026-07-18T13:00:00.000Z",
          id: "message-1",
          kind: "progress",
          message_md: "Cached message",
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const payload = url.includes("?")
          ? { nextCursor: null, runs: olderRuns }
          : { nextCursor: data(initialRuns, true).nextRunCursor, runs: initialRuns };
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );

    const view = panel(data(initialRuns, true), fake.supabase);

    expect(view.container.querySelectorAll("[data-run-id]")).toHaveLength(20);
    expect(fake.activeChannels.size).toBe(0);
    expect(
      view.container.querySelector('[data-run-id="run-1"] button')?.getAttribute("aria-expanded"),
    ).toBe("true");

    await waitFor(() => expect(fake.messageQueries.length).toBeGreaterThanOrEqual(1));
    expect(fake.messageQueries[0]).toBe("run-1");
    await screen.findByText("Cached message");

    await act(async () => idleCallback?.());
    expect(fake.activeChannels.size).toBe(2);

    fireEvent.click(view.container.querySelector('[data-run-id="run-2"] button[aria-expanded]')!);
    await waitFor(() => expect(fake.activeChannels.size).toBe(2));
    expect(
      view.container.querySelector('[data-run-id="run-1"] button')?.getAttribute("aria-expanded"),
    ).toBe("false");

    fireEvent.click(view.container.querySelector('[data-run-id="run-1"] button[aria-expanded]')!);
    expect(screen.getByText("Cached message")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await waitFor(() => expect(view.container.querySelectorAll("[data-run-id]")).toHaveLength(40));
    expect(fake.activeChannels.size).toBeLessThanOrEqual(2);
  });

  it("reconciles every subscribe/reconnect without duplicating run ids", async () => {
    const initialRun = run(1);
    const fake = fakeSupabase();
    let reconciled: WallieRun = { ...initialRun, status: "error" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ nextCursor: null, runs: [reconciled] }), { status: 200 }),
      ),
    );
    const view = panel(data([initialRun]), fake.supabase);

    await act(async () => idleCallback?.());
    const sessionChannel = fake.channels.find((channel) => channel.name.startsWith("wallie-runs:"));
    await act(async () => sessionChannel?.statusCallback?.("SUBSCRIBED"));
    await screen.findAllByText("Failed");

    reconciled = { ...initialRun, status: "success" };
    await act(async () => sessionChannel?.statusCallback?.("SUBSCRIBED"));
    await screen.findAllByText("Complete");
    expect(view.container.querySelectorAll('[data-run-id="run-1"]')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores stale reconcile snapshots when updating the pagination cursor", async () => {
    const olderFirstPage = Array.from({ length: 20 }, (_, index) => run(index + 21));
    const newerFirstPage = Array.from({ length: 20 }, (_, index) => run(index + 1));
    const olderCursor = {
      createdAt: olderFirstPage.at(-1)!.createdAt,
      id: olderFirstPage.at(-1)!.id,
    };
    const newerCursor = {
      createdAt: newerFirstPage.at(-1)!.createdAt,
      id: newerFirstPage.at(-1)!.id,
    };
    const gapPage = [run(41)];
    const fake = fakeSupabase();
    let resolveOlder!: (value: Response) => void;
    let resolveNewer!: (value: Response) => void;
    const olderPromise = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const newerPromise = new Promise<Response>((resolve) => {
      resolveNewer = resolve;
    });
    let reconcileCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("createdAt=")) {
        return Promise.resolve(
          new Response(JSON.stringify({ nextCursor: null, runs: gapPage }), { status: 200 }),
        );
      }

      reconcileCalls += 1;
      return reconcileCalls === 1 ? olderPromise : newerPromise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = panel(data(olderFirstPage, true), fake.supabase);

    await act(async () => idleCallback?.());
    const sessionChannel = fake.channels.find((channel) => channel.name.startsWith("wallie-runs:"));
    await act(async () => {
      sessionChannel?.statusCallback?.("SUBSCRIBED");
      sessionChannel?.statusCallback?.("SUBSCRIBED");
    });

    await act(async () => {
      resolveNewer(
        new Response(JSON.stringify({ nextCursor: newerCursor, runs: newerFirstPage }), {
          status: 200,
        }),
      );
    });
    await waitFor(() =>
      expect(view.container.querySelector('[data-run-id="run-1"]')).not.toBeNull(),
    );

    await act(async () => {
      resolveOlder(
        new Response(JSON.stringify({ nextCursor: olderCursor, runs: olderFirstPage }), {
          status: 200,
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await waitFor(() =>
      expect(view.container.querySelector('[data-run-id="run-41"]')).not.toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        `createdAt=${encodeURIComponent(newerCursor.createdAt)}&id=${newerCursor.id}`,
      ),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining(
        `createdAt=${encodeURIComponent(olderCursor.createdAt)}&id=${olderCursor.id}`,
      ),
    );
  });

  it("discards older-run pages that resolve after session navigation", async () => {
    const sessionOneRun = run(1);
    const sessionTwoRun = run(2, { stageName: "Session two only" });
    const leakedOlderRun = run(99, { stageName: "Leaked older run" });
    const fake = fakeSupabase();
    let resolveOlder!: (value: Response) => void;
    const olderPromise = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("createdAt=")) {
          return olderPromise;
        }

        return Promise.resolve(
          new Response(JSON.stringify({ nextCursor: null, runs: [sessionTwoRun] }), {
            status: 200,
          }),
        );
      }),
    );

    const view = render(
      <SessionWalliePanel
        initialData={data([sessionOneRun], true)}
        session={{ archivedAt: null, id: "session-1", workspaceId: "workspace-1" }}
        supabase={fake.supabase}
        workspaceSlug="acme"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    view.rerender(
      <SessionWalliePanel
        initialData={data([sessionTwoRun])}
        session={{ archivedAt: null, id: "session-2", workspaceId: "workspace-1" }}
        supabase={fake.supabase}
        workspaceSlug="acme"
      />,
    );

    await act(async () => {
      resolveOlder(
        new Response(JSON.stringify({ nextCursor: null, runs: [leakedOlderRun] }), {
          status: 200,
        }),
      );
    });

    expect(view.container.querySelector('[data-run-id="run-99"]')).toBeNull();
    expect(view.container.querySelector('[data-run-id="run-2"]')).not.toBeNull();
    expect(screen.queryByText("Leaked older run")).toBeNull();
    expect(screen.getByText("Session two only run")).not.toBeNull();
  });

  it("retries the selected paginated row and inserts the returned run without refresh", async () => {
    const initialRun = run(1);
    const olderRun = run(21, { canRetry: true, status: "error" });
    const retriedRun = run(0, {
      canCancel: true,
      createdAt: "2026-07-18T13:30:00.000Z",
      finishedAt: null,
      id: "run-retry",
      isActive: true,
      isTerminal: false,
      stageName: "Retried stage",
      status: "queued",
    });
    const fake = fakeSupabase();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ created: true, processScheduled: true, run: retriedRun }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ nextCursor: null, runs: [olderRun] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = panel(data([initialRun], true), fake.supabase);

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await waitFor(() =>
      expect(view.container.querySelector('[data-run-id="run-21"]')).not.toBeNull(),
    );
    const olderArticle = view.container.querySelector('[data-run-id="run-21"]');
    fireEvent.click(within(olderArticle as HTMLElement).getByRole("button", { name: "Retry Run" }));

    await waitFor(() =>
      expect(view.container.querySelector('[data-run-id="run-retry"]')).not.toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-runs/run-21/retry",
      expect.objectContaining({ method: "POST" }),
    );
    expect(view.container.querySelectorAll('[data-run-id="run-21"]')).toHaveLength(1);
  });

  it("updates the pagination cursor when reconcile returns a newer first page", async () => {
    const initialRuns = Array.from({ length: 20 }, (_, index) => run(index + 21));
    const reconciledRuns = Array.from({ length: 20 }, (_, index) => run(index + 1));
    const reconciledCursor = {
      createdAt: reconciledRuns.at(-1)!.createdAt,
      id: reconciledRuns.at(-1)!.id,
    };
    const gapPage = [run(41)];
    const fake = fakeSupabase();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("createdAt=")) {
        return new Response(JSON.stringify({ nextCursor: null, runs: gapPage }), { status: 200 });
      }
      return new Response(JSON.stringify({ nextCursor: reconciledCursor, runs: reconciledRuns }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = panel(data(initialRuns, true), fake.supabase);

    await act(async () => idleCallback?.());
    const sessionChannel = fake.channels.find((channel) => channel.name.startsWith("wallie-runs:"));
    await act(async () => sessionChannel?.statusCallback?.("SUBSCRIBED"));
    await waitFor(() =>
      expect(view.container.querySelector('[data-run-id="run-1"]')).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await waitFor(() =>
      expect(view.container.querySelector('[data-run-id="run-41"]')).not.toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        `createdAt=${encodeURIComponent(reconciledCursor.createdAt)}&id=${reconciledCursor.id}`,
      ),
    );
  });

  it("hydrates requesters for realtime runs using workspace members outside the first page", async () => {
    const initialRun = run(1);
    const fake = fakeSupabase();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ nextCursor: null, runs: [initialRun] }), { status: 200 }),
      ),
    );
    const view = panel(
      data([initialRun], false, { workspaceMembers: [offlineMember] }),
      fake.supabase,
    );

    await act(async () => idleCallback?.());
    const sessionChannel = fake.channels.find((channel) => channel.name.startsWith("wallie-runs:"));
    await act(async () => {
      sessionChannel?.changeCallback?.({
        eventType: "INSERT",
        new: {
          created_at: "2026-07-18T14:00:00.000Z",
          finished_at: null,
          id: "run-new",
          last_activity_at: "2026-07-18T14:00:00.000Z",
          model_name: "gpt-5",
          model_provider: "codex",
          run_type: "code",
          sandbox_id: null,
          sandbox_provider: null,
          stage_id: null,
          stage_name: "Build",
          stage_slug: "build",
          started_at: "2026-07-18T14:00:00.000Z",
          status: "queued",
          triggered_by_member_id: offlineMember.id,
          updated_at: "2026-07-18T14:00:00.000Z",
        },
      });
    });

    await waitFor(() =>
      expect(view.container.querySelector('[data-run-id="run-new"]')).not.toBeNull(),
    );
    expect(screen.getByText("Requested by Riley Offline")).not.toBeNull();
  });

  it("cancels the selected paginated row in place without a route refresh", async () => {
    const initialRun = run(1);
    const olderRun = run(21, {
      canCancel: true,
      finishedAt: null,
      isActive: true,
      isTerminal: false,
      status: "running",
    });
    const canceledRun = {
      ...olderRun,
      canCancel: false,
      finishedAt: "2026-07-18T13:01:00.000Z",
      isActive: false,
      isTerminal: true,
      status: "canceled" as const,
    };
    const fake = fakeSupabase();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ canceled: true, run: canceledRun }), { status: 200 });
      }
      return new Response(JSON.stringify({ nextCursor: null, runs: [olderRun] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = panel(data([initialRun], true), fake.supabase);

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await waitFor(() =>
      expect(view.container.querySelector('[data-run-id="run-21"]')).not.toBeNull(),
    );
    const olderArticle = view.container.querySelector('[data-run-id="run-21"]') as HTMLElement;
    fireEvent.click(within(olderArticle).getByRole("button", { name: "Cancel" }));

    await within(olderArticle).findByText("Canceled");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-runs/run-21/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(view.container.querySelectorAll('[data-run-id="run-21"]')).toHaveLength(1);
  });
});

describe("SessionWalliePanel activity states", () => {
  it("announces disconnect and restore while preserving run history", async () => {
    const initialRun = run(1, {
      finishedAt: null,
      isActive: true,
      isTerminal: false,
      lastActivityAt: "2026-07-18T12:55:00.000Z",
      messages: [
        {
          createdAt: "2026-07-18T12:01:00.000Z",
          id: "msg-1",
          kind: "progress",
          messageMd: "Cloning repository",
        },
      ],
      status: "running",
    });
    const fake = fakeSupabase({
      "run-1": [
        {
          agent_run_id: "run-1",
          created_at: "2026-07-18T12:01:00.000Z",
          id: "msg-1",
          kind: "progress",
          message_md: "Cloning repository",
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ nextCursor: null, runs: [initialRun] }), { status: 200 }),
      ),
    );
    const view = render(
      <SessionWalliePanel
        initialData={data([initialRun], false, { loadedMessageRunIds: ["run-1"] })}
        initialNow="2026-07-18T12:56:00.000Z"
        session={{ archivedAt: null, id: "session-1", workspaceId: "workspace-1" }}
        supabase={fake.supabase}
        workspaceSlug="acme"
      />,
    );

    expect(screen.getAllByText("Cloning repository").length).toBeGreaterThan(0);
    expect(screen.getByText("Connecting…")).not.toBeNull();

    await act(async () => idleCallback?.());
    const sessionChannel = fake.channels.find((channel) => channel.name.startsWith("wallie-runs:"));
    await act(async () => sessionChannel?.statusCallback?.("SUBSCRIBED"));
    expect(screen.getByText("Live")).not.toBeNull();

    await act(async () => sessionChannel?.statusCallback?.("CHANNEL_ERROR"));
    expect(screen.getAllByText("Disconnected — history preserved").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cloning repository").length).toBeGreaterThan(0);

    await act(async () => sessionChannel?.statusCallback?.("SUBSCRIBED"));
    expect(screen.getAllByText("Live updates restored").length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll('[data-run-id="run-1"]')).toHaveLength(1);
  });

  it("keeps disclosure stable when realtime updates arrive on another run", async () => {
    const latest = run(1, { stageName: "Latest" });
    const older = run(2, { stageName: "Older" });
    const fake = fakeSupabase();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ nextCursor: null, runs: [latest, older] }), {
            status: 200,
          }),
      ),
    );
    const view = panel(data([latest, older]), fake.supabase);

    fireEvent.click(view.container.querySelector('[data-run-id="run-2"] button[aria-expanded]')!);
    expect(
      view.container.querySelector('[data-run-id="run-2"] button')?.getAttribute("aria-expanded"),
    ).toBe("true");

    await act(async () => idleCallback?.());
    const sessionChannel = fake.channels.find((channel) => channel.name.startsWith("wallie-runs:"));
    await act(async () => {
      sessionChannel?.changeCallback?.({
        eventType: "UPDATE",
        new: {
          created_at: latest.createdAt,
          finished_at: latest.finishedAt,
          id: latest.id,
          last_activity_at: latest.lastActivityAt,
          model_name: latest.modelName,
          model_provider: latest.modelProvider,
          run_type: latest.runType,
          sandbox_id: null,
          sandbox_provider: null,
          stage_id: latest.stageId,
          stage_name: latest.stageName,
          stage_slug: latest.stageSlug,
          started_at: latest.startedAt,
          status: "success",
          triggered_by_member_id: null,
          updated_at: "2026-07-18T13:05:00.000Z",
        },
      });
    });

    expect(
      view.container.querySelector('[data-run-id="run-2"] button')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      view.container.querySelector('[data-run-id="run-1"] button')?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("renders retried attempt metadata in the active summary", () => {
    const retried = run(1, {
      attemptCount: 3,
      finishedAt: null,
      isActive: true,
      isTerminal: false,
      lastActivityAt: "2026-07-18T12:55:00.000Z",
      status: "queued",
    });
    const fake = fakeSupabase();
    render(
      <SessionWalliePanel
        initialData={data([retried])}
        initialNow="2026-07-18T12:56:00.000Z"
        session={{ archivedAt: null, id: "session-1", workspaceId: "workspace-1" }}
        supabase={fake.supabase}
        workspaceSlug="acme"
      />,
    );

    expect(screen.getByText("Waiting in queue")).not.toBeNull();
    expect(screen.getByText("3")).not.toBeNull();
    expect(screen.getAllByText("Queued").length).toBeGreaterThan(0);
  });
});
