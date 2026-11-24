import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { Constants, type Database, type Json } from "@/lib/supabase/database.types";

type Admin = Pick<SupabaseClient<Database>, "rpc">;
type Provider = Database["public"]["Enums"]["connector_provider"];
type Settlement = Database["public"]["Functions"]["settle_connector_outbound_delivery"]["Args"];
const rpcTimeoutMs = 5_000;

type EnqueueInput = {
  workspaceId: string;
  factoryId: string;
  resourceId: string;
  sessionId: string;
  sourceId: string;
  logicalKey: string;
  actorLinkId?: string;
  content: Record<string, Json>;
} & ({ operation: "reply" | "linear_status" } | { operation: "edit"; editedDeliveryId: string });

export async function enqueueConnectorOutboundDelivery(admin: Admin, input: EnqueueInput) {
  const { data, error } = await admin
    .rpc("enqueue_connector_outbound_delivery", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_resource_id: input.resourceId,
      p_session_id: input.sessionId,
      p_source_id: input.sourceId,
      p_logical_key: input.logicalKey,
      p_operation: input.operation,
      p_content: input.content,
      ...(input.actorLinkId ? { p_actor_link_id: input.actorLinkId } : {}),
      ...(input.operation === "edit" ? { p_edited_delivery_id: input.editedDeliveryId } : {}),
    })
    .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
  if (error) throw error;
  return z.uuid().parse(data);
}

const providerId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\p{Cc}]+$/u);
const jsonObject = z.record(z.string(), z.json());
const storedContent = z.custom<Record<string, Json>>(
  (value) => jsonObject.safeParse(value).success,
);
const claimFields = z.object({
  delivery_id: z.uuid(),
  lease_id: z.uuid(),
  lease_expires_at: z.iso.datetime({ offset: true }),
  kind: z.enum(["sending", "observing"]),
  provider: z.enum(Constants.public.Enums.connector_provider),
  external_resource_id: providerId,
  external_thread_id: providerId,
  content: storedContent,
  installation_id: z.uuid(),
  installation_generation: z.number().int().positive(),
  mapping_revision: z.number().int().positive(),
  credential_ref: z.uuid(),
  credential_material_revision: z.number().int().positive().nullable(),
});

const claim = z
  .discriminatedUnion("operation", [
    claimFields.extend({ operation: z.literal("reply"), edit_target: z.null() }),
    claimFields.extend({ operation: z.literal("edit"), edit_target: providerId }),
    claimFields.extend({ operation: z.literal("linear_status"), edit_target: z.null() }),
  ])
  .refine((row) => row.operation !== "linear_status" || row.provider === "linear")
  .transform((row) => ({
    kind: row.kind,
    provider: row.provider,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    target: {
      correlationId: row.delivery_id,
      leaseId: row.lease_id,
      externalResourceId: row.external_resource_id,
      externalThreadId: row.external_thread_id,
      installationId: row.installation_id,
      installationGeneration: row.installation_generation,
      mappingRevision: row.mapping_revision,
      credentialRef: row.credential_ref,
      credentialMaterialRevision: row.credential_material_revision,
      message:
        row.operation === "edit"
          ? { operation: row.operation, providerReplyId: row.edit_target, content: row.content }
          : { operation: row.operation, content: row.content },
    },
  }));

export type ConnectorOutboundTarget = z.output<typeof claim>["target"];
type Limited =
  | { kind: "rate_limited"; retryAfterSeconds?: number }
  | { kind: "credential_unavailable" };
type SendResult =
  | { kind: "sent"; providerReplyId: string }
  | { kind: "not_sent" | "uncertain" | "rejected" }
  | Limited;
type Observation =
  | { kind: "found"; providerReplyId: string }
  | { kind: "absent" | "inconclusive" }
  | Limited;

export type ConnectorOutboundAdapter = {
  provider: Provider;
  send(target: ConnectorOutboundTarget, signal: AbortSignal): Promise<SendResult>;
  observe(target: ConnectorOutboundTarget, signal: AbortSignal): Promise<Observation>;
};

async function runAttempt(
  adapter: ConnectorOutboundAdapter,
  attempt: z.output<typeof claim>,
  timeoutMs: number,
): Promise<SendResult | Observation> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return attempt.kind === "sending"
      ? await adapter.send(attempt.target, signal)
      : await adapter.observe(attempt.target, signal);
  } catch {
    return { kind: attempt.kind === "sending" ? "uncertain" : "inconclusive" };
  }
}

const claimResponse = z.union([z.tuple([]), z.tuple([claim])]);

export async function drainConnectorOutboundDeliveries(
  admin: Admin,
  adapter: ConnectorOutboundAdapter,
  options: { isShuttingDown?: () => boolean } = {},
) {
  let settled = 0;
  for (let index = 0; index < 4; index++) {
    if (options.isShuttingDown?.()) break;
    const { data, error } = await admin
      .rpc("claim_connector_outbound_delivery", { p_provider: adapter.provider })
      .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
    if (error) throw new Error("Could not claim a connector delivery.", { cause: error });
    const [attempt] = claimResponse.parse(data);
    if (!attempt) break;
    if (attempt.provider !== adapter.provider) throw new Error("Connector provider scope changed.");

    const leaseEndsAt = Date.parse(attempt.leaseExpiresAt);
    const beforeAuthorization = leaseEndsAt - Date.now() - rpcTimeoutMs;
    if (beforeAuthorization <= 0) continue;
    const authority = await admin
      .rpc("confirm_connector_outbound_authority", {
        p_delivery_id: attempt.target.correlationId,
        p_lease_id: attempt.leaseId,
      })
      .abortSignal(AbortSignal.timeout(Math.min(beforeAuthorization, rpcTimeoutMs)));
    if (authority.error)
      throw new Error("Could not confirm connector delivery authority.", {
        cause: authority.error,
      });
    if (!authority.data) continue;
    const leaseRemaining = leaseEndsAt - Date.now();
    if (leaseRemaining <= 0) continue;
    const transportTime = leaseRemaining - rpcTimeoutMs;
    const outcome: SendResult | Observation =
      transportTime > 0
        ? await runAttempt(adapter, attempt, Math.min(transportTime, 15_000))
        : attempt.kind === "sending"
          ? { kind: "not_sent" }
          : { kind: "inconclusive" };
    const args: Settlement = {
      p_delivery_id: attempt.target.correlationId,
      p_lease_id: attempt.leaseId,
      p_result: outcome.kind,
      ...("providerReplyId" in outcome ? { p_provider_reply_id: outcome.providerReplyId } : {}),
      ...(outcome.kind === "rate_limited" && outcome.retryAfterSeconds !== undefined
        ? { p_retry_after_seconds: outcome.retryAfterSeconds }
        : {}),
    };
    const resolution = await admin
      .rpc("settle_connector_outbound_delivery", args)
      .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
    if (resolution.error)
      throw new Error("Could not settle a connector delivery.", { cause: resolution.error });
    if (resolution.data) settled += 1;
  }
  return settled;
}
