import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export async function reconcileBenchmarkSchedules(admin: Pick<SupabaseClient<Database>, "rpc">) {
  const { error } = await admin
    .rpc("reconcile_factory_benchmark_schedules", { p_limit: 25 })
    .abortSignal(AbortSignal.timeout(15_000));
  if (error) throw new Error("Could not reconcile benchmark schedules.");
}

export async function reconcileBenchmarkEvaluations(admin: Pick<SupabaseClient<Database>, "rpc">) {
  const { error } = await admin
    .rpc("reconcile_factory_benchmark_evaluations", { p_limit: 25 })
    .abortSignal(AbortSignal.timeout(15_000));
  if (error) throw new Error("Could not reconcile benchmark evaluations.");
}
