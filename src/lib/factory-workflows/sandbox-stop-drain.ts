import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { stopRunSandbox } from "@/lib/pipeline/cancel";
import type { Database } from "@/lib/supabase/database.types";

const claimLimit = 4;

/** Retry durable sandbox obligations without treating a submitted stop as confirmation. */
export async function drainFactoryWorkflowSandboxStops(admin: SupabaseClient<Database>) {
  const claimed = await admin.rpc("claim_factory_workflow_sandbox_stops", {
    p_limit: claimLimit,
  });
  if (claimed.error) throw new Error("Could not claim pending workflow sandbox stops.");

  const settled = await Promise.allSettled(
    claimed.data.map(async ({ obligation_id, lease_token, run_id, ...sandbox }) => {
      let confirmed = false;
      try {
        confirmed = await stopRunSandbox(admin, { id: run_id, ...sandbox }, undefined, {
          throwOnError: true,
        });
      } catch {
        // The exact provider or connection is unavailable. Keep the obligation retryable.
      }
      const receipt = await admin.rpc("settle_factory_workflow_sandbox_stop", {
        p_obligation_id: obligation_id,
        p_lease_token: lease_token,
        p_confirmed: confirmed,
      });
      if (receipt.error) throw new Error("Could not settle a workflow sandbox stop.");
      return receipt.data && confirmed;
    }),
  );

  const confirmed = settled.filter(
    (receipt) => receipt.status === "fulfilled" && receipt.value,
  ).length;
  return { claimed: settled.length, confirmed, pending: settled.length - confirmed };
}
