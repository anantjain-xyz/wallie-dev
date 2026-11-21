import assert from "node:assert/strict";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { readBenchmarkComparison } from "@/lib/factory-benchmarks/comparison";
import { requestBenchmarkSchedule } from "@/lib/factory-benchmarks/schedule";
import { reconcileBenchmarkSchedules } from "@/lib/factory-benchmarks/schedule-maintenance";
import type { Database } from "@/lib/supabase/database.types";

const loopback = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
});
const configSchema = z.object({
  url: loopback,
  serviceKey: z.string().min(1),
  publishableKey: z.string().min(1),
});
const witnessSchema = z.object({
  workspaceId: z.uuid(),
  factoryId: z.uuid(),
  actorUserId: z.uuid(),
  experimentId: z.uuid(),
  taskId: z.uuid(),
  taskRevisionId: z.uuid(),
  suiteId: z.uuid(),
  suiteRevisionId: z.uuid(),
  archivedCommit: z.string().regex(/^[a-f0-9]{40}$/),
  archivedTree: z.string().regex(/^[a-f0-9]{40}$/),
  frozenTrialIds: z.array(z.uuid()).length(8),
  nodeTrialId: z.uuid(),
  nativeTrialId: z.uuid(),
  ownerEmail: z.email(),
  workspaceSlug: z.string().min(1),
  sourceRunId: z.uuid(),
  siblingFactoryId: z.uuid(),
});

export type QualificationWitness = z.infer<typeof witnessSchema>;
export const qualificationReserveUsd = 0.125;
export const qualificationTitle = "Count archived README lines";
export const qualificationPrompt = "Count the lines in the README.md at the supplied checkout.";
export const qualificationAcceptance = "Record three README lines in a private commit.";
export const qualificationRef = "refs/heads/qualification-original";
export const qualificationSuite = "Archived README qualification";
export const qualificationRepository = "anantjain-xyz/wallie-dev";

export function parseQualificationWitness(raw: string | undefined) {
  return witnessSchema.parse(JSON.parse(raw ?? ""));
}

export function createQualificationClients(raw: string | undefined) {
  const config = configSchema.parse(JSON.parse(raw ?? ""));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  return {
    config,
    admin: createClient<Database, "public">(config.url, config.serviceKey, options),
    viewer: createClient<Database, "public">(config.url, config.publishableKey, options),
  };
}

export async function receipt<T>(
  request: PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<NonNullable<T>> {
  const { data, error } = await request;
  assert(!error, error?.message);
  assert(
    data !== null && data !== undefined,
    "The qualification command did not return a receipt.",
  );
  return data;
}

export type QualificationAdmin = SupabaseClient<Database>;
export type QualificationScope = Pick<
  QualificationWitness,
  "workspaceId" | "factoryId" | "actorUserId" | "experimentId"
>;

export function scheduleScope(admin: QualificationAdmin, scope: QualificationScope) {
  return { admin, ...scope, signal: AbortSignal.timeout(15_000) };
}

export async function readTrialReport(admin: QualificationAdmin, scope: QualificationScope) {
  return readBenchmarkComparison(scheduleScope(admin, scope), { limit: 30, candidateLimit: 10 });
}

export async function findNextReservedTrial(admin: QualificationAdmin, scope: QualificationScope) {
  const reservations = await receipt(
    admin
      .from("factory_benchmark_schedule_trials")
      .select("trial_id,run_id")
      .eq("experiment_id", scope.experimentId)
      .is("accounted_at", null),
  );
  const [reserved] = reservations;
  assert.equal(reservations.length, 1, "Exactly one scheduled attempt must own the free slot.");
  assert(reserved);
  const trial = await trialRow(admin, reserved.trial_id);
  assert.equal(trial.run_id, reserved.run_id);
  return { ...reserved, job_id: trial.job_id };
}

export async function reconcileAndReserve(admin: QualificationAdmin, scope: QualificationScope) {
  await reconcileBenchmarkSchedules(admin);
  return findNextReservedTrial(admin, scope);
}

export async function controlQualification(
  admin: QualificationAdmin,
  scope: QualificationScope,
  action: "pause" | "resume" | "cancel" | "read",
) {
  return requestBenchmarkSchedule(scheduleScope(admin, scope), { action });
}

export function rpcScope(scope: QualificationScope) {
  return {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorUserId,
  };
}

export async function trialRow(admin: QualificationAdmin, id: string) {
  return receipt(
    admin
      .from("factory_benchmark_trials")
      .select("id,status,failure_code,job_id,run_id,session_id,attempt_count,deadline_at")
      .eq("id", id)
      .single(),
  );
}

export function allowQualificationFetch(
  adminUrl: string,
  originalFetch: typeof fetch,
  archiveSha: string | null,
) {
  const origin = new URL(adminUrl).origin;
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new URL(input instanceof Request ? input.url : input);
    if (request.origin === origin) return originalFetch(input, init);
    if (
      request.origin === "https://api.github.com" &&
      /^\/repositories\/\d+\/git\/ref\/heads\/qualification-original$/.test(request.pathname)
    ) {
      assert.equal(init?.method ?? "GET", "GET");
      return Promise.resolve(
        archiveSha
          ? Response.json({ ref: qualificationRef, object: { type: "commit", sha: archiveSha } })
          : new Response(null, { status: 404 }),
      );
    }
    throw new Error("The qualification tried to use an unapproved transport.");
  };
}
