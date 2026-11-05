import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  deferSessionJobForGitContinuityRelease,
  isGitContinuityReleasePause,
} from "./git-continuity-release";

afterEach(() => vi.useRealTimers());

describe("Git continuity release pause", () => {
  it("recognizes the structured admission code without guessing from messages", () => {
    expect(isGitContinuityReleasePause({ code: "P499P", message: "Paused" })).toBe(true);
    for (const error of [null, "P499P", new Error("P499P"), { code: "42501" }, { code: "p499p" }])
      expect(isGitContinuityReleasePause(error)).toBe(false);
  });

  function client(result: Promise<{ data: boolean | null; error: unknown }>) {
    const abortSignal = vi.fn<(signal: AbortSignal) => typeof result>(() => result);
    const rpc = vi.fn(() => ({ abortSignal }));
    return { admin: { rpc } as unknown as SupabaseClient<Database>, rpc, abortSignal };
  }
  it("defers exactly the captured job attempt through the fenced RPC", async () => {
    const { admin, rpc, abortSignal } = client(Promise.resolve({ data: true, error: null }));
    expect(
      await deferSessionJobForGitContinuityRelease({ admin, jobId: "job", attemptCount: 3 }),
    ).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("defer_session_job_for_continuity_release", {
      p_job_id: "job",
      p_attempt_count: 3,
    });
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
  it.each([
    { data: false, error: null },
    { data: null, error: null },
    { data: null, error: { message: "Response lost" } },
  ])("does not claim deferral succeeded without a receipt", async (result) => {
    const { admin } = client(Promise.resolve(result));
    expect(
      await deferSessionJobForGitContinuityRelease({ admin, jobId: "job", attemptCount: 3 }),
    ).toBe(false);
  });
  it("bounds a transport that ignores cancellation without failing the generation", async () => {
    vi.useFakeTimers();
    const { admin, abortSignal } = client(new Promise(() => undefined));
    const pending = deferSessionJobForGitContinuityRelease({
      admin,
      jobId: "job",
      attemptCount: 3,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(false);
    expect(abortSignal.mock.calls[0][0].aborted).toBe(true);
  });
  it("keeps a rejected transport from becoming a generation failure", async () => {
    const { admin } = client(Promise.reject(new Error("Unavailable")));
    expect(
      await deferSessionJobForGitContinuityRelease({ admin, jobId: "job", attemptCount: 3 }),
    ).toBe(false);
  });
});
