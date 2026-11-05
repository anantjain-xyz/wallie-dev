import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@/lib/supabase/database.types";
import {
  deleteRetainedCheckpointRefWithWorkspace,
  RetainedCheckpointRefConflictError,
} from "./checkpoint-cleanup-git";
import { resolveSourceDeliveryRepository } from "./source-delivery";
import { withSourceGitSandbox } from "./source-delivery-sandbox";

type Admin = SupabaseClient<Database>;
type Cleanup = Tables<"session_checkpoint_cleanup">;

/** Only the database can authorize retirement; the Git lease protects the remote ref. */
export async function cleanRetainedCheckpoint(admin: Admin, cleanup: Cleanup, signal: AbortSignal) {
  const assertClaim = async () => {
    signal.throwIfAborted();
    const { data, error } = await admin
      .rpc("assert_session_checkpoint_cleanup_claim", {
        p_run_id: cleanup.run_id,
        p_claim_id: cleanup.claim_id!,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error || data !== true) throw new Error("Checkpoint retirement claim expired.");
  };
  await assertClaim();
  const repository = await resolveSourceDeliveryRepository(admin, cleanup, signal);
  if (
    repository.repositoryNumericId !== cleanup.github_repository_id ||
    repository.delivery.repository_full_name !== cleanup.repository_full_name
  )
    throw new Error("Checkpoint retirement repository identity changed.");
  const receipt = await withSourceGitSandbox(
    signal,
    { admin, workspaceId: cleanup.workspace_id, runId: cleanup.run_id },
    (dependencies) =>
      deleteRetainedCheckpointRefWithWorkspace(
        {
          runId: cleanup.run_id,
          headSha: cleanup.expected_sha,
          remoteUrl: `https://github.com/${cleanup.repository_full_name}.git`,
          token: repository.token,
          signal,
          beforeDelete: assertClaim,
        },
        dependencies,
      ),
  );
  if (receipt.ref !== cleanup.retained_ref || !receipt.absent)
    throw new Error("Checkpoint retirement receipt does not match its intent.");
  await assertClaim();
  const { data, error } = await admin
    .rpc("finish_session_checkpoint_cleanup", {
      p_run_id: cleanup.run_id,
      p_claim_id: cleanup.claim_id!,
      p_remote_absent: true,
    })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (error || data !== true) throw new Error("Checkpoint retirement receipt was not accepted.");
}

/** Candidate cleanup remains available while execution and PR admission are paused. */
export async function drainCheckpointCleanup(
  admin: Admin,
  options: { limit?: number; timeoutMs?: number; runId?: string } = {},
) {
  const result = { retired: 0, failed: 0 };
  for (let index = 0; index < (options.limit ?? 2); index++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new Error("Cleanup timed out.")), {
        once: true,
      }),
    );
    let cleanup: Cleanup | null = null;
    try {
      const work = (async () => {
        const { data: claim, error } = await admin
          .rpc("claim_session_checkpoint_cleanup", {
            ...(options.runId ? { p_run_id: options.runId } : {}),
          })
          .abortSignal(controller.signal);
        controller.signal.throwIfAborted();
        if (error) throw new Error("Checkpoint cleanup claim failed.");
        if (!claim) return false;
        const { data, error: readError } = await admin
          .from("session_checkpoint_cleanup")
          .select("*")
          .eq("claim_id", claim)
          .abortSignal(controller.signal)
          .single();
        controller.signal.throwIfAborted();
        if (readError || !data) throw new Error("Checkpoint cleanup intent is unavailable.");
        cleanup = data;
        await cleanRetainedCheckpoint(admin, data, controller.signal);
        return true;
      })();
      if (!(await Promise.race([work, aborted]))) break;
      result.retired++;
    } catch (error) {
      result.failed++;
      const current = cleanup as Cleanup | null;
      if (current?.claim_id && !controller.signal.aborted) {
        await Promise.race([
          admin
            .rpc("fail_session_checkpoint_cleanup", {
              p_run_id: current.run_id,
              p_claim_id: current.claim_id,
              p_error_code:
                error instanceof RetainedCheckpointRefConflictError
                  ? "remote_ref_conflict"
                  : "cleanup_failed",
            })
            .abortSignal(controller.signal),
          aborted,
        ]).catch(() => undefined);
      }
      console.warn("[checkpoint-cleanup] retirement deferred", { runId: current?.run_id });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return result;
}
