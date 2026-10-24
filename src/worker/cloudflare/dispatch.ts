import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;
export type JobDispatch = Tables<"worker_dispatches">;
export type AuthDispatch = Tables<"worker_auth_dispatches">;
export interface WorkflowBinding<Params> {
  create(input: { id: string; params: Params }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
export type AttemptParams = { jobId: string; attemptCount: number; workflowId: string };
export type AuthParams = { flowId: string; claimToken: string; workflowId: string };

/** A create timeout is ambiguous: inspect the same ID before acknowledging it. */
export async function ensureWorkflow<Params>(
  binding: WorkflowBinding<Params>,
  id: string,
  params: Params,
) {
  try {
    await binding.create({ id, params });
  } catch {
    const status = await (await binding.get(id)).status();
    if (status.status === "unknown") throw new Error("Workflow delivery is unconfirmed.");
  }
}

export async function recoverAttempt(
  admin: AdminClient,
  jobId: string,
  attemptCount: number,
  message: string,
  retry = true,
) {
  // A runless failure may race start. Retry the lookup once, preserving the
  // exact attempt throughout, as in the Node supervisor.
  for (let lookup = 0; lookup < 2; lookup++) {
    const { data: run, error } = await admin
      .from("agent_runs")
      .select("id, status, source_recovery_required, workspace_id")
      .eq("agent_job_id", jobId)
      .eq("attempt_count", attemptCount)
      .maybeSingle();
    if (error) throw new Error("Could not inspect interrupted attempt.");
    if (run?.status === "success") {
      const result = await admin.rpc("complete_session_job_attempt", {
        p_job_id: jobId,
        p_attempt_count: attemptCount,
        p_run_id: run.id,
      });
      if (result.error) throw new Error("Could not acknowledge published attempt.");
      return;
    }
    let maxRetries = 3;
    if (run) {
      const config = await admin
        .from("workspace_agent_config")
        .select("value_json")
        .eq("workspace_id", run.workspace_id)
        .eq("key", "max_retries")
        .maybeSingle();
      if (config.error) throw new Error("Could not load retry policy.");
      if (typeof config.data?.value_json === "number") maxRetries = config.data.value_json;
    }
    const result = await admin.rpc("fail_session_job_attempt", {
      p_job_id: jobId,
      p_attempt_count: attemptCount,
      p_run_id: run?.id,
      p_error: message,
      p_retry: retry && !run?.source_recovery_required,
      p_max_retries: maxRetries,
    });
    if (result.error) throw new Error("Could not recover interrupted attempt.");
    if (run || result.data !== "stale") return;
  }
}

export async function dispatchWork(
  admin: AdminClient,
  bindings: {
    attempts: WorkflowBinding<AttemptParams>;
    auth: WorkflowBinding<AuthParams>;
  },
  config: { maxConcurrent: number; timeoutMs: number; dispatchJobs?: boolean },
) {
  let delivered = 0;
  let failed = 0;
  const deliverJob = async (dispatch: JobDispatch) => {
    const { data: job, error } = await admin
      .from("agent_jobs")
      .select("status, attempt_count")
      .eq("id", dispatch.job_id)
      .maybeSingle();
    if (error) throw new Error("Could not inspect dispatch ownership.");
    if (job?.status !== "running" || job.attempt_count !== dispatch.attempt_count) {
      const obsolete = await admin
        .from("worker_dispatches")
        .delete()
        .eq("job_id", dispatch.job_id)
        .eq("attempt_count", dispatch.attempt_count);
      if (obsolete.error) throw new Error("Could not discard obsolete dispatch.");
      return;
    }
    if (Date.parse(dispatch.deadline_at) <= Date.now()) {
      await recoverAttempt(
        admin,
        dispatch.job_id,
        dispatch.attempt_count,
        "Worker attempt deadline expired before dispatch.",
        false,
      );
      return;
    }
    await ensureWorkflow(bindings.attempts, dispatch.workflow_id, {
      jobId: dispatch.job_id,
      attemptCount: dispatch.attempt_count,
      workflowId: dispatch.workflow_id,
    });
    const { error: ackError } = await admin
      .from("worker_dispatches")
      .update({ dispatched_at: new Date().toISOString() })
      .eq("job_id", dispatch.job_id)
      .eq("attempt_count", dispatch.attempt_count);
    if (ackError) throw new Error("Could not acknowledge workflow dispatch.");
    delivered++;
  };
  const safely = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch {
      failed++;
      console.warn("[cloudflare-dispatch] delivery will retry");
    }
  };
  if (config.dispatchJobs !== false) {
    const pending = await admin
      .from("worker_dispatches")
      .select("*")
      .is("dispatched_at", null)
      .order("created_at")
      .limit(100);
    if (pending.error) throw new Error("Could not load pending dispatches.");
    for (const dispatch of pending.data ?? []) await safely(() => deliverJob(dispatch));
    for (let slot = 0; slot < config.maxConcurrent; slot++) {
      const claimed = await admin.rpc("claim_next_worker_dispatch", {
        p_max_concurrent: config.maxConcurrent,
        p_default_workspace_limit: 2,
        p_timeout_ms: config.timeoutMs,
      });
      if (claimed.error) throw new Error("Could not claim workflow dispatch.");
      const dispatch = claimed.data?.[0];
      if (!dispatch) break;
      await safely(() => deliverJob(dispatch));
    }
  }

  const deliverAuth = async (dispatch: AuthDispatch) => {
    const current = await admin
      .from("cursor_auth_flows")
      .select("claimed_by, status, expires_at")
      .eq("id", dispatch.flow_id)
      .maybeSingle();
    if (current.error) throw new Error("Could not inspect auth dispatch.");
    if (
      current.data?.claimed_by !== dispatch.claim_token ||
      !["processing", "prompted"].includes(current.data.status) ||
      Date.parse(current.data.expires_at) <= Date.now()
    ) {
      const obsolete = await admin
        .from("worker_auth_dispatches")
        .delete()
        .eq("flow_id", dispatch.flow_id)
        .eq("claim_token", dispatch.claim_token);
      if (obsolete.error) throw new Error("Could not discard obsolete auth dispatch.");
      return;
    }
    await ensureWorkflow(bindings.auth, dispatch.workflow_id, {
      flowId: dispatch.flow_id,
      claimToken: dispatch.claim_token,
      workflowId: dispatch.workflow_id,
    });
    const ack = await admin
      .from("worker_auth_dispatches")
      .update({ dispatched_at: new Date().toISOString() })
      .eq("flow_id", dispatch.flow_id)
      .eq("claim_token", dispatch.claim_token);
    if (ack.error) throw new Error("Could not acknowledge auth dispatch.");
  };
  const authPending = await admin
    .from("worker_auth_dispatches")
    .select("*")
    .is("dispatched_at", null)
    .order("created_at")
    .limit(20);
  if (authPending.error) throw new Error("Could not load auth dispatches.");
  for (const dispatch of authPending.data ?? []) await safely(() => deliverAuth(dispatch));
  for (let slot = 0; slot < 4; slot++) {
    const claimed = await admin.rpc("claim_next_worker_auth_dispatch");
    if (claimed.error) throw new Error("Could not claim Cursor sign-in.");
    const dispatch = claimed.data?.[0];
    if (!dispatch) break;
    await safely(() => deliverAuth(dispatch));
  }
  return { delivered, failed };
}
