// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useApprovalReview } from "./use-approval-review";

vi.mock("@/lib/supabase/public-config-provider", () => ({ useSupabasePublicConfig: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
