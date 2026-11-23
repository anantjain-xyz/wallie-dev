import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";
import type { Database } from "@/lib/supabase/database.types";

import { factoryAutomationPathSchema, factoryAutomationReadQuerySchema } from "./contracts";
import { automationDryRunEventSchema } from "./dry-run-contracts";

type Admin = Pick<SupabaseClient<Database>, "rpc">;
const occurrenceBatchSize = 4;
const occurrenceTimeoutMs = 8_000;
const id = z.string().uuid().toLowerCase();
const timestamp = z.string().datetime({ offset: true });

const recordOccurrenceSchema = factoryAutomationPathSchema.extend({
  expectedRevisionId: factoryAutomationReadQuerySchema.shape.revisionId.unwrap(),
  sourceNamespace: z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/),
  sourceKey: z
    .string()
    .min(1)
    .refine(
      (value) =>
        isFactoryDefinitionText(value) &&
        value === value.trim() &&
        [...value].length <= 240 &&
        !/\p{Cc}/u.test(value),
    ),
  event: automationDryRunEventSchema,
  causalSessionId: id.optional(),
});

const occurrenceReceipt = z.strictObject({
  occurrenceId: id,
  workspaceId: id,
  factoryId: id,
  automationId: id,
  revisionId: id,
  attemptCount: z.number().int().nonnegative().safe(),
  recordedAt: timestamp,
  replayed: z.boolean(),
});

const occurrenceReceiptSchema = z.discriminatedUnion("status", [
  occurrenceReceipt.extend({
    status: z.literal("pending"),
    reason: z.enum(["paused", "capacity", "authority_changing"]).nullable(),
    sessionId: z.null(),
    mutationReceiptId: z.null(),
    nextAttemptAt: timestamp,
    settledAt: z.null(),
  }),
  occurrenceReceipt.extend({
    status: z.literal("admitted"),
    reason: z.null(),
    sessionId: id,
    mutationReceiptId: id,
    nextAttemptAt: z.null(),
    settledAt: timestamp,
  }),
  occurrenceReceipt.extend({
    status: z.literal("denied"),
    reason: z.enum([
      "automation_archived",
      "revision_changed",
      "event_no_match",
      "recursive_event",
      "invalid_cause",
      "invalid_assignment",
      "budget_exhausted",
      "retry_exhausted",
      "factory_unavailable",
    ]),
    sessionId: z.null(),
    mutationReceiptId: z.null(),
    nextAttemptAt: z.null(),
    settledAt: timestamp,
  }),
]);

export async function recordFactoryAutomationOccurrence(
  admin: Admin,
  input: z.input<typeof recordOccurrenceSchema>,
  signal?: AbortSignal,
) {
  const command = recordOccurrenceSchema.parse(input);
  const deadline = AbortSignal.timeout(occurrenceTimeoutMs);
  const { data, error } = await admin
    .rpc("record_factory_automation_occurrence", {
      p_workspace_id: command.workspaceId,
      p_factory_id: command.factoryId,
      p_automation_id: command.automationId,
      p_expected_revision_id: command.expectedRevisionId,
      p_source_namespace: command.sourceNamespace,
      p_source_key: command.sourceKey,
      p_event: command.event,
      ...(command.causalSessionId ? { p_causal_session_id: command.causalSessionId } : {}),
    })
    .abortSignal(signal ? AbortSignal.any([signal, deadline]) : deadline);
  if (error) throw error;
  return occurrenceReceiptSchema.parse(data);
}

export async function drainFactoryAutomationOccurrences(admin: Admin) {
  const signal = AbortSignal.timeout(occurrenceTimeoutMs);
  for (let attempt = 0; attempt < occurrenceBatchSize && !signal.aborted; attempt++) {
    const { data, error } = await admin
      .rpc("admit_next_factory_automation_occurrence")
      .abortSignal(signal);
    if (error) throw new Error("Could not admit factory automation occurrences.", { cause: error });
    if (data === null) return;
    occurrenceReceiptSchema.parse(data);
  }
}
