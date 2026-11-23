import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import {
  dispatchActionsDelivery,
  observeActionsDelivery,
} from "@/features/github/actions-delivery";
import type { Database } from "@/lib/supabase/database.types";

import { actionsDeliveryDispatch, actionsDeliveryObservation } from "./actions-contract";

const dispatchKey = actionsDeliveryDispatch.pick({
  workspaceId: true,
  factoryId: true,
  commandId: true,
});

function scopedCommand(target: z.infer<typeof dispatchKey>) {
  return {
    p_workspace_id: target.workspaceId,
    p_factory_id: target.factoryId,
    p_command_id: target.commandId,
  };
}

type ProviderTransport = Pick<
  Parameters<typeof dispatchActionsDelivery>[0],
  "fetcher" | "mintToken"
>;

export async function reconcileFactoryActionsDelivery(
  admin: SupabaseClient<Database>,
  transport?: ProviderTransport,
) {
  const result = { dispatchReceipts: 0, observationsRecorded: 0, failed: 0 };
  const { data, error } = await admin
    .rpc("list_factory_actions_dispatches")
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error("Could not list pending Actions delivery commands.");

  for (const pending of dispatchKey.array().parse(data)) {
    const scope = scopedCommand(pending);
    try {
      const { data, error } = await admin
        .rpc("claim_factory_actions_dispatch", scope)
        .abortSignal(AbortSignal.timeout(5_000));
      if (error?.code === "55P03" || error?.code === "57014") {
        const deferred = await admin
          .rpc("defer_factory_actions_dispatch", scope)
          .abortSignal(AbortSignal.timeout(5_000));
        if (deferred.error) result.failed++;
        continue;
      }
      if (error) throw new Error("Could not claim the Actions delivery command.");
      if (data === null) continue;
      const target = actionsDeliveryDispatch.parse(data);
      const remaining = Date.parse(target.leaseExpiresAt) - Date.now() - 5_000;
      if (remaining <= 0) continue;
      const outcome = await dispatchActionsDelivery({
        ...transport,
        target,
        signal: AbortSignal.timeout(Math.min(Math.floor(remaining), 22_000)),
      });
      const settled = await admin
        .rpc("settle_factory_actions_dispatch", {
          ...scope,
          p_lease_id: target.leaseId,
          p_dispatch_state: outcome.kind,
          p_reason:
            outcome.kind === "accepted"
              ? "awaiting_run"
              : outcome.kind === "unknown"
                ? "dispatch_unknown"
                : outcome.reason,
          ...(outcome.kind === "accepted" ? { p_run_id: outcome.runId } : {}),
        })
        .abortSignal(AbortSignal.timeout(5_000));
      if (settled.error) throw new Error("Could not settle the Actions dispatch receipt.");
      if (settled.data) result.dispatchReceipts++;
    } catch {
      result.failed++;
    }
  }

  const observations = await admin
    .rpc("reserve_factory_actions_observations")
    .abortSignal(AbortSignal.timeout(5_000));
  if (observations.error) throw new Error("Could not reserve Actions delivery observations.");
  // Reserve clocks bound individual probes. Poll two at once to leave space in
  // Workerd's outbound connection limit and finish before the reservation expires.
  const targets = actionsDeliveryObservation.array().parse(observations.data);
  for (let offset = 0; offset < targets.length; offset += 2) {
    const batch = await Promise.allSettled(
      targets.slice(offset, offset + 2).map(async (target) => {
        const observation = await observeActionsDelivery({
          ...transport,
          target,
          signal: AbortSignal.timeout(12_000),
        });
        const verified = observation.kind === "observed";
        const recorded = await admin
          .rpc("settle_factory_actions_observation", {
            ...scopedCommand(target),
            p_observation_id: target.observationId,
            p_reason: verified ? "run_verified" : observation.reason,
            ...(verified
              ? {
                  p_run_id: observation.runId,
                  p_run_status: observation.status,
                  ...(observation.conclusion ? { p_run_conclusion: observation.conclusion } : {}),
                }
              : {}),
          })
          .abortSignal(AbortSignal.timeout(5_000));
        if (recorded.error) throw new Error("Could not record the Actions run observation.");
        return recorded.data;
      }),
    );
    for (const checked of batch) {
      if (checked.status === "rejected") result.failed++;
      else if (checked.value) result.observationsRecorded++;
    }
  }
  return result;
}
