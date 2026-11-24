import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { evaluateSessionPrReadiness } from "@/lib/pipeline/pr-readiness";
import type { Database } from "@/lib/supabase/database.types";
import { resolveQueuedRunConfig } from "@/lib/wallie/service";
import { wakeWorker } from "@/lib/worker/wake";

const claimSchema = z.object({
  action_id: z.uuid(),
  lease_id: z.uuid(),
  workspace_id: z.uuid(),
  session_id: z.uuid(),
  action: z.enum(["approve", "answer"]),
});

type Admin = SupabaseClient<Database>;

export async function drainSlackReviewActions(admin: Admin, workspaceId?: string) {
  let applied = 0;
  for (let count = 0; count < 4; count++) {
    const claimed = await admin.rpc(
      "claim_slack_review_action",
      workspaceId ? { p_workspace_id: workspaceId } : {},
    );
    if (claimed.error) throw new Error("Could not claim a Slack review action.");
    if (!claimed.data[0]) break;
    const action = claimSchema.parse(claimed.data[0]);

    const config = await resolveQueuedRunConfig(admin, {
      id: action.session_id,
      workspace_id: action.workspace_id,
    });
    if (action.action === "approve") {
      try {
        await evaluateSessionPrReadiness(admin, action.session_id, { record: true });
      } catch {
        // The authoritative approval command fails closed when readiness is missing.
      }
    }

    const completed = await admin.rpc("complete_slack_review_action", {
      p_action_id: action.action_id,
      p_lease_id: action.lease_id,
      p_agent_model_provider: config.modelProvider,
      p_agent_model_name: config.modelName,
      p_run_type: config.runType,
    });
    if (completed.error) throw new Error("Could not settle a Slack review action.");
    if (completed.data === "applied") applied++;
  }
  if (applied > 0) await wakeWorker();
  return applied;
}
