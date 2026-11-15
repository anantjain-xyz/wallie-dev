// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RunTranscriptEntry,
  RunTranscriptPage,
} from "@/features/wallie/run-transcript-contracts";
import { RunTranscriptLive } from "@/features/wallie/run-transcript-live";

const mocks = vi.hoisted(() => {
  const router = { refresh: vi.fn() };
  return {
    router,
    recovery: {
      register: vi.fn<(entry: { refresh: (signal: AbortSignal) => Promise<void> }) => () => void>(),
      invalidate: vi.fn(),
      retry: vi.fn(),
    },
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/supabase/public-config-provider", () => ({ useSupabasePublicConfig: () => null }));
vi.mock("@/features/wallie/realtime-recovery-context", () => ({
  useRealtimeRecovery: () => ({ recovery: mocks.recovery, connection: "reconnecting" }),
}));

const runId = "selected-run";

function entry(sequence: number): RunTranscriptEntry {
  return {
    id: `event:${sequence}`,
    kind: "text",
    payload: { text: `Recorded item ${sequence}` },
    createdAt: "2026-11-14T00:00:00.000Z",
    sequence,
    causationSequence: null,
    truncated: false,
  };
}

function page(sequences: number[], overrides: Partial<RunTranscriptPage> = {}): RunTranscriptPage {
  return {
    runId,
    runStatus: "running",
    attemptCount: 1,
    mode: "events",
    expiredAt: null,
    entries: sequences.map(entry),
    newerCursor: String(sequences.at(-1) ?? 0),
    olderCursor: String(sequences.at(0) ?? 0),
    hasOlder: false,
    hasNewer: false,
    ...overrides,
  };
}

function mount(initialPage: RunTranscriptPage) {
  render(
    <RunTranscriptLive initialPage={initialPage} runId={runId} workspaceId="selected-workspace" />,
  );
}

function rows() {
  return within(screen.getByRole("list", { name: "Run activity" }))
    .getAllByRole("listitem")
    .map((row) => within(row).getByText(/Recorded item/).textContent);
}

async function refresh() {
  const entry = mocks.recovery.register.mock.calls.at(-1)?.[0];
  expect(entry).toBeDefined();
  await act(() => entry!.refresh(new AbortController().signal));
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("exact run transcript", () => {
  it("clears previously displayed activity after an expiry receipt", async () => {
    const expired = page([], {
      expiredAt: "2026-11-15T00:00:00Z",
      mode: "legacy",
      runStatus: "success",
    });
    const fetchTranscript = vi.fn().mockResolvedValue(Response.json(expired));
    vi.stubGlobal("fetch", fetchTranscript);
    mount(page([2], { runStatus: "success", hasOlder: true }));
    const loadEarlier = screen.getByRole("button", { name: "Load earlier activity" });
    await act(async () => fireEvent.click(loadEarlier));
    expect(screen.queryByText("Recorded item 2")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load earlier activity" })).toBeNull();
    expect(
      screen.getByText("This transcript expired under the workspace retention policy."),
    ).toBeTruthy();
  });

  it("keeps the initial page bounded and retains keyboard focus while loading older activity", async () => {
    const fetchTranscript = vi.fn().mockResolvedValue(Response.json(page([1, 2])));
    vi.stubGlobal("fetch", fetchTranscript);
    mount(page([3, 4], { runStatus: "success", hasOlder: true }));
    expect(rows()).toEqual(["Recorded item 3", "Recorded item 4"]);
    expect(fetchTranscript).not.toHaveBeenCalled();
    const earlier = screen.getByRole("button", { name: "Load earlier activity" });
    earlier.focus();
    await act(async () => fireEvent.click(earlier));
    expect(fetchTranscript).toHaveBeenCalledWith(
      "/api/workspaces/selected-workspace/runs/selected-run/transcript?cursor=3&direction=older",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(rows()).toEqual([1, 2, 3, 4].map((number) => `Recorded item ${number}`));
    expect(screen.getByRole("button", { name: "Beginning of transcript" })).toBe(
      document.activeElement,
    );
  });

  it("catches up in order across pages, deduplicates the tail, and keeps a canceled run terminal", async () => {
    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page([5], { runStatus: "canceled", hasNewer: true })))
      .mockResolvedValueOnce(Response.json(page([6], { runStatus: "running" })))
      .mockResolvedValueOnce(Response.json(page([3, 4, 5, 6], { runStatus: "running" })))
      .mockResolvedValueOnce(Response.json(page([], { newerCursor: "6" })))
      .mockResolvedValueOnce(Response.json(page([5, 6])));
    vi.stubGlobal("fetch", fetchTranscript);
    mount(page([2, 4]));
    await refresh();
    expect(
      fetchTranscript.mock.calls.map(([url]) => new URL(url, "https://test.invalid").search),
    ).toEqual(["?cursor=4&direction=newer", "?cursor=5&direction=newer", ""]);
    expect(rows()).toEqual([2, 3, 4, 5, 6].map((number) => `Recorded item ${number}`));
    expect(screen.getByText("Canceled")).toBeTruthy();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    await refresh();
    expect(screen.getByText("Canceled")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
    expect(rows()).toEqual([2, 3, 4, 5, 6].map((number) => `Recorded item ${number}`));
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("restores the earlier-page boundary when late records fall outside the refreshed tail", async () => {
    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page([], { newerCursor: "40" })))
      .mockResolvedValueOnce(
        Response.json(
          page(
            Array.from({ length: 30 }, (_, i) => i + 11),
            { hasOlder: true },
          ),
        ),
      )
      .mockResolvedValueOnce(Response.json(page(Array.from({ length: 10 }, (_, i) => i + 1))));
    vi.stubGlobal("fetch", fetchTranscript);
    mount(page([40]));
    expect(screen.queryByRole("button", { name: "Load earlier activity" })).toBeNull();
    await refresh();
    expect(rows()).toHaveLength(30);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Load earlier activity" })),
    );
    expect(fetchTranscript).toHaveBeenLastCalledWith(
      "/api/workspaces/selected-workspace/runs/selected-run/transcript?cursor=11&direction=older",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(rows()).toEqual(Array.from({ length: 40 }, (_, i) => `Recorded item ${i + 1}`));
  });

  it("keeps the earlier-page control hidden when the full earlier range is already loaded", async () => {
    const original = Array.from({ length: 30 }, (_, i) => i + 1);
    const tail = Array.from({ length: 30 }, (_, i) => i + 2);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(page([31])))
        .mockResolvedValueOnce(Response.json(page(tail, { hasOlder: true }))),
    );
    mount(page(original));
    await refresh();
    expect(rows()).toHaveLength(31);
    expect(screen.queryByRole("button", { name: "Load earlier activity" })).toBeNull();
  });

  it("restarts when the exact run changes from legacy to structured capture", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 409 }))
        .mockResolvedValueOnce(Response.json(page([1]))),
    );
    mount(
      page([], {
        mode: "legacy",
        entries: [
          {
            id: "old-message",
            kind: "legacy",
            payload: { kind: "text", text: "Historical message" },
            sequence: null,
            causationSequence: null,
            createdAt: "2026-11-14T00:00:00.000Z",
            truncated: false,
          },
        ],
      }),
    );
    expect(screen.getByText("Legacy activity has no structured capture receipt.")).toBeTruthy();
    await refresh();
    expect(screen.queryByText("Historical message")).toBeNull();
    expect(rows()).toEqual(["Recorded item 1"]);
  });

  it("clears already-rendered messages if authorization is revoked during reconnect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    mount(page([1]));
    expect(screen.getByText("Recorded item 1")).toBeTruthy();
    await refresh();
    expect(screen.getByRole("alert").textContent).toMatch(/transcript is unavailable/);
    expect(screen.queryByText("Recorded item 1")).toBeNull();
  });
});
