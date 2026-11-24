import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { evaluateSessionPrReadiness } from "@/lib/pipeline/pr-readiness";
import type { Database } from "@/lib/supabase/database.types";
import { resolveQueuedRunConfig } from "@/lib/wallie/service";
import { wakeWorker } from "@/lib/worker/wake";

const claimSchema = z.object({
  kind: z.literal("action"),
  action_id: z.uuid(),
  lease_id: z.uuid(),
  workspace_id: z.uuid(),
  session_id: z.uuid(),
  action: z.enum(["approve", "answer"]),
});
const claimResult = z.discriminatedUnion("kind", [
  claimSchema,
  z.object({ kind: z.literal("cleanup") }),
]);
const rpcTimeoutMs = 5_000;

type Admin = SupabaseClient<Database>;
type DrainInput = { workspaceId?: string; isShuttingDown?: () => boolean };
const batchSize = 4;

export async function drainSlackReviewActions(admin: Admin, input: DrainInput = {}) {
  return (await drainSlackReviewActionBatch(admin, input)).applied;
}

export async function drainSlackReviewActionBatch(admin: Admin, input: DrainInput = {}) {
  let applied = 0;
  let claims = 0;
  for (; claims < batchSize; claims++) {
    if (input.isShuttingDown?.()) break;
    const claimed = await admin
      .rpc(
        "claim_slack_review_action",
        input.workspaceId ? { p_workspace_id: input.workspaceId } : {},
      )
      .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
    if (claimed.error) throw new Error("Could not claim a Slack review action.");
    if (!claimed.data[0]) break;
    const action = claimResult.parse(claimed.data[0]);
    if (action.kind === "cleanup") continue;

    const config = await resolveQueuedRunConfig(admin, {
      id: action.session_id,
      workspace_id: action.workspace_id,
    });
    if (action.action === "approve") {
      try {
        await evaluateSessionPrReadiness(admin, action.session_id, { record: true });
      } catch {
        // Keep the action eligible for its next lease when readiness could not be recorded.
        continue;
      }
    }

    const completed = await admin
      .rpc("complete_slack_review_action", {
        p_action_id: action.action_id,
        p_lease_id: action.lease_id,
        p_agent_model_provider: config.modelProvider,
        p_agent_model_name: config.modelName,
        p_run_type: config.runType,
      })
      .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
    // A timed-out completion may have committed. The next claim can recover an unsettled lease.
    if (completed.error) throw new Error("Could not settle a Slack review action.");
    if (completed.data === "applied") applied++;
  }
  if (applied > 0) await wakeWorker();
  return { applied, hasMore: claims === batchSize && !input.isShuttingDown?.() };
}
