// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useApprovalReview } from "./use-approval-review";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { SupabasePublicConfig } from "@/lib/supabase/config";

const mocked = vi.hoisted(() => ({
  config: null as SupabasePublicConfig | null,
  loadClient: vi.fn<() => Promise<SupabaseClient<Database>>>(),
}));

vi.mock("@/lib/supabase/deferred-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/deferred-browser")>()),
  loadSupabaseBrowserClient: mocked.loadClient,
}));

vi.mock("@/lib/supabase/public-config-provider", () => ({
  useSupabasePublicConfig: () => mocked.config,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mocked.config = null;
  mocked.loadClient.mockReset();
});

it("fails closed until a current review count is confirmed, and refreshes without navigation", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ reviewRevision: 4, blockingCount: 2 }))
    .mockResolvedValueOnce(Response.json({ reviewRevision: 6, blockingCount: 0 }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useApprovalReview("session", "artifact"));
  expect(result.current.value).toBeNull();
  await waitFor(() =>
    expect(result.current.value).toEqual({ reviewRevision: 4, blockingCount: 2 }),
  );
  await act(() => result.current.refresh());
  expect(result.current.value).toEqual({ reviewRevision: 6, blockingCount: 0 });
  expect(fetcher).toHaveBeenCalledWith("/api/sessions/session/approval-review", {
    cache: "no-store",
  });
});

it("rejects unavailable or malformed evidence and permits a recovery refresh", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ reviewRevision: 4, blockingCount: -1 }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(Response.json({ reviewRevision: 5, blockingCount: 0 }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useApprovalReview("session", "artifact"));
  await waitFor(() => expect(result.current.error).toContain("Could not confirm"));
  expect(result.current.value).toBeNull();
  await act(() => result.current.refresh());
  expect(result.current.value).toBeNull();
  await act(() => result.current.refresh());
  expect(result.current.value?.reviewRevision).toBe(5);
});

it("ignores late evidence from a different artifact and invalidates when review closes", async () => {
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(Response.json({ reviewRevision: 8, blockingCount: 1 })),
  );
  const { result, rerender } = renderHook(
    ({ artifact, session }: { artifact: string; session: string | undefined }) =>
      useApprovalReview(session, artifact),
    { initialProps: { session: "session" as string | undefined, artifact: "old" } },
  );
  rerender({ session: "session", artifact: "new" });
  await waitFor(() => expect(result.current.value?.reviewRevision).toBe(8));
  await act(async () => resolveFirst(Response.json({ reviewRevision: 1, blockingCount: 0 })));
  expect(result.current.value?.blockingCount).toBe(1);
  rerender({ session: undefined, artifact: "new" });
  expect(result.current.value).toBeNull();
});

function realtimeClient() {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "session-token" } },
        error: null,
      }),
    },
    realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return { client: client as unknown as SupabaseClient<Database>, calls: client, channel };
}

it("confirms HTTP review while SDK loading is pending and ignores a late artifact subscription", async () => {
  mocked.config = { url: "https://example.supabase.co", publishableKey: "public-key" };
  const old = realtimeClient();
  const current = realtimeClient();
  let finishOld!: (client: SupabaseClient<Database>) => void;
  mocked.loadClient
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    )
    .mockResolvedValue(current.client);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ reviewRevision: 8, blockingCount: 1 }));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender, unmount } = renderHook(
    ({ artifact }) => useApprovalReview("session", artifact),
    { initialProps: { artifact: "old" } },
  );
  await waitFor(() => expect(result.current.value?.reviewRevision).toBe(8));
  expect(old.calls.channel).not.toHaveBeenCalled();
  rerender({ artifact: "new" });
  await waitFor(() => expect(current.channel.subscribe).toHaveBeenCalledOnce());
  await act(async () => finishOld(old.client));
  expect(old.calls.channel).not.toHaveBeenCalled();
  expect(current.calls.channel).toHaveBeenCalledWith("approval-review:session:new");
  const acknowledged = current.channel.subscribe.mock.calls[0][0] as (status: string) => void;
  const before = fetcher.mock.calls.length;
  act(() => acknowledged("SUBSCRIBED"));
  await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before));
  unmount();
  expect(current.calls.removeChannel).toHaveBeenCalledExactlyOnceWith(current.channel);
});

it("retries a failed SDK load without withholding the authoritative HTTP review", async () => {
  vi.useFakeTimers();
  mocked.config = { url: "https://example.supabase.co", publishableKey: "public-key" };
  const current = realtimeClient();
  mocked.loadClient
    .mockRejectedValueOnce(new Error("Chunk load failed"))
    .mockResolvedValue(current.client);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ reviewRevision: 9, blockingCount: 0 })),
  );
  const { result, unmount } = renderHook(() => useApprovalReview("session", "artifact"));
  await act(async () => {});
  expect(result.current.value).toEqual({ reviewRevision: 9, blockingCount: 0 });
  expect(current.calls.channel).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mocked.loadClient).toHaveBeenCalledTimes(2);
  expect(current.channel.subscribe).toHaveBeenCalledOnce();
  unmount();
  expect(current.calls.removeChannel).toHaveBeenCalledExactlyOnceWith(current.channel);
});
