import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/** This code is emitted only by the database's execution admission boundary. */
export function isGitContinuityReleasePause(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P499P";
}

/**
 * A pause is an idle/deferred claim, never a failed generation. An independent
 * bound permits this cleanup after the attempt's own cancellation signal; SQL
 * still checks the captured attempt and refuses any started execution.
 */
export async function deferSessionJobForGitContinuityRelease(input: {
  admin: SupabaseClient<Database>;
  jobId: string;
  attemptCount: number;
}): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, 5_000);
  });
  try {
    return await Promise.race([
      (async () => {
        const { data, error } = await input.admin
          .rpc("defer_session_job_for_continuity_release", {
            p_job_id: input.jobId,
            p_attempt_count: input.attemptCount,
          })
          .abortSignal(controller.signal);
        return !controller.signal.aborted && !error && data === true;
      })(),
      timeout,
    ]);
  } catch {
    // An unknown response is not permission to fail the job. The authoritative
    // stalled-claim transition makes the same pause-aware deferral decision.
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
