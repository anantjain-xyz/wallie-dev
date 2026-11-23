import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import { createFactoryAutomationSchedule } from "./schedule";

type Client = Pick<SupabaseClient<Database>, "rpc">;
const timeoutMs = 8_000;
const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const version = z.number().int().nonnegative().safe();

const dueScheduleSchema = z.strictObject({
  workspaceId: id,
  factoryId: id,
  automationId: id,
  revisionId: id,
  cursorVersion: version,
  admissionGeneration: version,
  scannedThrough: timestamp,
  through: timestamp,
  cron: z.string(),
  timeZone: z.string(),
});
const previewStateSchema = z.strictObject({
  asOf: timestamp,
  current: z.boolean(),
  archived: z.boolean(),
  paused: z.boolean(),
  scannedThrough: timestamp.nullable(),
  resumeThrough: timestamp.nullable(),
  lastResumeThrough: timestamp.nullable(),
  lastResumeOccurrenceAt: timestamp.nullable(),
});

function toTimestamp(instant: number | null) {
  return instant === null ? null : new Date(instant).toISOString();
}

export async function reconcileFactoryAutomationSchedules(admin: Client) {
  const signal = AbortSignal.timeout(timeoutMs);
  const { data, error } = await admin
    .rpc("list_due_factory_automation_schedules")
    .abortSignal(signal);
  if (error) throw new Error("Could not load due factory automation schedules.", { cause: error });
  const due = z.array(dueScheduleSchema).max(4).parse(data);
  const results = await Promise.allSettled(
    due.map(async (row) => {
      const expected = {
        p_workspace_id: row.workspaceId,
        p_factory_id: row.factoryId,
        p_automation_id: row.automationId,
        p_revision_id: row.revisionId,
        p_expected_cursor_version: row.cursorVersion,
        p_expected_admission_generation: row.admissionGeneration,
      };
      const schedule = createFactoryAutomationSchedule(row);
      if (!schedule) {
        const deferred = await admin
          .rpc("defer_factory_automation_schedule", expected)
          .abortSignal(signal);
        throw new Error(`The schedule for automation ${row.automationId} could not be resolved.`, {
          cause: deferred.error ?? undefined,
        });
      }
      const through = Date.parse(row.through);
      const occurrenceAt = schedule.latestDueOccurrence(Date.parse(row.scannedThrough), through);
      const nextDueAt = schedule.nextOccurrences(through, 1)[0] ?? null;
      const settled = await admin
        .rpc("commit_factory_automation_schedule", {
          ...expected,
          p_plan: {
            through: row.through,
            occurrenceAt: toTimestamp(occurrenceAt),
            nextDueAt: toTimestamp(nextDueAt),
          },
        })
        .abortSignal(signal);
      if (settled.error) throw settled.error;
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure)
    throw new Error("Could not reconcile a factory automation schedule.", {
      cause: failure.reason,
    });
}

export async function previewFactoryAutomationSchedule(
  client: Client,
  input: {
    workspaceId: string;
    factoryId: string;
    automationId: string;
    revisionId: string;
    cron: string;
    timeZone: string;
  },
) {
  const { data, error } = await client
    .rpc("read_factory_automation_schedule_preview", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_automation_id: input.automationId,
      p_revision_id: input.revisionId,
    })
    .abortSignal(AbortSignal.timeout(timeoutMs));
  if (error) throw new Error("Could not load the automation schedule preview.", { cause: error });
  if (data === null) return null;
  const state = previewStateSchema.parse(data);
  const schedule = createFactoryAutomationSchedule(input);
  const asOf = Date.parse(state.asOf);
  const next =
    schedule?.nextOccurrences(asOf, 3).map((instant) => new Date(instant).toISOString()) ?? [];
  const catchUpThrough = state.paused ? state.asOf : state.resumeThrough;
  const catchUp =
    state.current && !state.archived && catchUpThrough && state.scannedThrough
      ? {
          through: catchUpThrough,
          occurrenceAt: toTimestamp(
            schedule?.latestDueOccurrence(
              Date.parse(state.scannedThrough),
              Date.parse(catchUpThrough),
            ) ?? null,
          ),
        }
      : null;
  const lastResume =
    state.current &&
    !state.archived &&
    !state.paused &&
    !state.resumeThrough &&
    state.lastResumeThrough
      ? { through: state.lastResumeThrough, occurrenceAt: state.lastResumeOccurrenceAt }
      : null;
  return {
    asOf: state.asOf,
    current: state.current,
    archived: state.archived,
    paused: state.paused,
    available: schedule !== null,
    next,
    catchUp,
    lastResume,
  };
}
