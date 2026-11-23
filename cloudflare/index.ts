import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { cloudflareEnvSchema } from "@/env/cloudflare";
import { workerRunCaptureEnvSchema } from "@/env/worker";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { WorkerAttemptDeadlineError } from "@/lib/pipeline/worker-attempt-deadline";
import { runClaimedJob } from "@/worker/loop";
import { processClaimedCursorAuthFlow } from "@/lib/cursor/auth-processor";
import { registerWorker, sendHeartbeat, deregisterWorker } from "@/worker/heartbeat";
import {
  dispatchWork,
  ensureWorkflow,
  recoverAttempt,
  type AttemptParams,
  type AuthParams,
} from "@/worker/cloudflare/dispatch";
import { sweepStalledRuns } from "@/worker/stall-detector";
import { reapOrphanSandboxes } from "@/worker/sandbox-reaper";
import { reconcileLinearState } from "@/worker/reconciler";
import { drainSourceDeliveries } from "@/lib/pipeline/source-delivery";
import { drainCanonicalPullRequests } from "@/lib/pipeline/canonical-pr-publisher";
import { drainAcceptedTriageRoute } from "@/lib/factory-workflows/triage-dispatch";
import { drainCheckpointPublications } from "@/lib/pipeline/checkpoint-publication";
import { drainFactoryWorkflowSandboxStops } from "@/lib/factory-workflows/sandbox-stop-drain";
import { drainCheckpointCleanup } from "@/lib/pipeline/checkpoint-cleanup";
import { cleanupRunExports, drainRunExports } from "@/lib/run-exports/worker";
import { cleanupExpiredSessionAttachments } from "@/lib/storage/session-attachment-cleanup";
import { drainRunRetention } from "@/lib/run-retention/maintenance";
import { pruneFactoryOAuthCredentials } from "@/lib/factory-oauth/maintenance";
import { pruneFactoryCommandAdmissions } from "@/lib/factory-command-authorization/maintenance";
import { drainFactoryDiagnoses } from "@/lib/factory-diagnosis/worker";
import { drainFactoryJudges } from "@/lib/factory-evaluations/judge-worker";
import { maintainFactoryEvaluationQueue } from "@/lib/factory-evaluations/maintenance";
import { processFactoryFailureCohorts } from "@/lib/factory-failures/maintenance";
import {
  reconcileBenchmarkEvaluations,
  reconcileBenchmarkSchedules,
} from "@/lib/factory-benchmarks/schedule-maintenance";
import {
  processFactoryFlowProjection,
  pruneFactoryAnalyticsExports,
} from "@/lib/factory-outcomes/maintenance";
import { processFactoryScorerSampling } from "@/lib/factory-scorers/sampling-maintenance";
import { processFactoryRoutingCanaryAlerts } from "@/lib/model-routing/canary-alert-maintenance";
import { pruneFactoryEventOutbox } from "@/lib/factory-event-subscriptions/maintenance";
import { requestFactoryEventDispatch } from "@/lib/factory-event-subscriptions/relay";
import { resumePendingWorkspaceDeletions } from "@/lib/workspaces/deletion";
import { reconcileGitHubPrVerification } from "@/features/github/pr-verification-service";
import { reconcilePrReadiness } from "@/lib/pipeline/pr-readiness";

export interface Env {
  [key: string]: unknown;
  DISPATCHER: DurableObjectNamespace<Dispatcher>;
  SESSION_ATTEMPT: Workflow<AttemptParams>;
  CURSOR_AUTH: Workflow<AuthParams>;
  MAINTENANCE: Workflow<{ tick: number }>;
  WALLIE_WORKER_WAKE_SECRET: string;
  WALLIE_WORKER_DISPATCH_ENABLED: string;
  WALLIE_WORKER_AUTH_ENABLED?: string;
}

const enabled = (env: Env) => {
  const config = cloudflareEnvSchema.parse(env);
  return (
    config.WALLIE_WORKER_DISPATCH_ENABLED === "true" || config.WALLIE_WORKER_AUTH_ENABLED === "true"
  );
};
const dispatcher = (env: Env) => env.DISPATCHER.getByName("production");

export class Dispatcher extends DurableObject<Env> {
  private activeDispatch?: Promise<void>;

  async kick() {
    if (!enabled(this.env)) return;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 1000)
      await this.ctx.storage.setAlarm(Date.now() + 1);
  }

  async alarm() {
    // RPC wake-ups may arrive while remote APIs are pending. Share one batch
    // without holding blockConcurrencyWhile's 30-second initialization gate.
    if (this.activeDispatch) return this.activeDispatch;
    const batch = this.dispatch().finally(() => {
      this.activeDispatch = undefined;
    });
    this.activeDispatch = batch;
    return batch;
  }

  private async dispatch() {
    if (!enabled(this.env)) return;
    // Keep a recovery alarm even when a database/API call fails or hangs.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const config = cloudflareEnvSchema.parse(this.env);
    const admin = createSupabaseAdminClient();
    try {
      const result = await dispatchWork(
        admin,
        { attempts: this.env.SESSION_ATTEMPT, auth: this.env.CURSOR_AUTH },
        {
          maxConcurrent: config.WORKER_MAX_CONCURRENT_JOBS,
          timeoutMs: config.WORKER_JOB_TIMEOUT_MS,
          dispatchJobs: config.WALLIE_WORKER_DISPATCH_ENABLED === "true",
        },
      );
      if (result.delivered || result.failed) console.log("[cloudflare-dispatch] batch", result);
      if (config.WALLIE_WORKER_DISPATCH_ENABLED === "true") await this.maintain();
    } catch {
      console.error("[cloudflare-dispatch] batch failed; recovery alarm armed");
    }
    const active = await admin
      .from("agent_jobs")
      .select("id")
      .in("status", ["queued", "started", "running"])
      .limit(1);
    const auth = await admin
      .from("cursor_auth_flows")
      .select("id")
      .in("status", ["starting", "processing", "prompted"])
      .limit(1);
    if (
      (config.WALLIE_WORKER_DISPATCH_ENABLED === "true" && active.data?.length) ||
      auth.data?.length
    )
      await this.ctx.storage.setAlarm(Date.now() + 2000);
  }

  private async maintain() {
    const previous = await this.ctx.storage.get<string>("maintenance");
    if (previous) {
      try {
        const status = await (await this.env.MAINTENANCE.get(previous)).status();
        if (!["complete", "errored", "terminated"].includes(status.status)) return;
      } catch {
        await ensureWorkflow(this.env.MAINTENANCE, previous, {
          tick: Number(previous.split("-").at(-1)),
        });
        return;
      }
    }
    const tick = Math.floor(Date.now() / 60_000);
    const id = `maintenance-${tick}`;
    if (previous === id) return;
    await this.ctx.storage.put("maintenance", id);
    await ensureWorkflow(this.env.MAINTENANCE, id, { tick });
  }
}

export class SessionAttemptWorkflow extends WorkflowEntrypoint<Env, AttemptParams> {
  async run(event: WorkflowEvent<AttemptParams>, step: WorkflowStep) {
    const { jobId, attemptCount, workflowId } = event.payload;
    if (workflowId !== event.instanceId) throw new Error("Workflow identity mismatch.");
    const { WALLIE_ORDERED_RUN_CAPTURE_ENABLED: captureOrderedEvents } =
      workerRunCaptureEnvSchema.parse(this.env);
    const admin = createSupabaseAdminClient();
    let failure: WorkerAttemptDeadlineError | string | undefined;
    try {
      const execution = await step.do(
        "execute captured attempt",
        { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" },
        async () => {
          const dispatch = await admin
            .from("worker_dispatches")
            .select("deadline_at")
            .eq("job_id", jobId)
            .eq("attempt_count", attemptCount)
            .eq("workflow_id", workflowId)
            .single();
          if (dispatch.error) throw new Error("Attempt dispatch is unavailable.");
          const deadlineMs = Date.parse(dispatch.data.deadline_at);
          if (deadlineMs <= Date.now()) return "deadline_elapsed";
          const claim = await admin.rpc("begin_worker_dispatch", {
            p_job_id: jobId,
            p_attempt_count: attemptCount,
            p_workflow_id: workflowId,
          });
          if (claim.error) throw new Error("Could not fence attempt execution.");
          if (!claim.data) {
            if (deadlineMs <= Date.now()) return "deadline_elapsed";
            throw new Error("Attempt execution was already started or expired.");
          }
          const job = await admin
            .from("agent_jobs")
            .select("*")
            .eq("id", jobId)
            .eq("attempt_count", attemptCount)
            .eq("status", "running")
            .single();
          if (job.error) throw new Error("Captured attempt is no longer current.");
          const remaining = deadlineMs - Date.now();
          if (remaining <= 0) return "deadline_elapsed";
          const workerId = `cloudflare-${workflowId}`;
          const heartbeats = new Set<Promise<void>>();
          await registerWorker(admin, workerId);
          const heartbeat = () => {
            const task = sendHeartbeat(admin, workerId, [jobId])
              .catch(() =>
                console.warn("[cloudflare-attempt] heartbeat unavailable", { jobId, attemptCount }),
              )
              .finally(() => heartbeats.delete(task));
            heartbeats.add(task);
          };
          const timer = setInterval(heartbeat, 10_000);
          try {
            await sendHeartbeat(admin, workerId, [jobId]);
            await runClaimedJob(admin, job.data, {
              captureOrderedEvents,
              timeoutMs: remaining,
              deadlineAt: dispatch.data.deadline_at,
              workerRuntime: "workerd",
            });
          } finally {
            clearInterval(timer);
            await Promise.allSettled(heartbeats);
            await deregisterWorker(admin, workerId);
          }
        },
      );
      if (execution === "deadline_elapsed")
        failure = new WorkerAttemptDeadlineError(
          "Worker attempt deadline expired before execution.",
        );
    } catch {
      console.warn("[cloudflare-attempt] execution interrupted", { jobId, attemptCount });
      failure = "Cloudflare execution interrupted or reached its deadline.";
    }
    if (failure) {
      const disposition = failure;
      await step.do(
        "recover captured attempt",
        {
          timeout: "30 seconds",
          retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
        },
        () => recoverAttempt(admin, jobId, attemptCount, disposition),
      );
    }
    await step.do("wake dispatcher", () => dispatcher(this.env).kick());
  }
}

export class CursorAuthWorkflow extends WorkflowEntrypoint<Env, AuthParams> {
  async run(event: WorkflowEvent<AuthParams>, step: WorkflowStep) {
    const { flowId, claimToken, workflowId } = event.payload;
    if (workflowId !== event.instanceId) throw new Error("Workflow identity mismatch.");
    await step.do(
      "process claimed sign-in",
      { timeout: "15 minutes", retries: { limit: 0, delay: "1 second" } },
      async () => {
        const admin = createSupabaseAdminClient();
        const claim = await admin
          .from("worker_auth_dispatches")
          .update({ execution_started_at: new Date().toISOString() })
          .eq("flow_id", flowId)
          .eq("claim_token", claimToken)
          .eq("workflow_id", workflowId)
          .is("execution_started_at", null)
          .select("flow_id")
          .maybeSingle();
        if (claim.error) throw new Error("Could not fence Cursor sign-in.");
        if (!claim.data) return;
        const flow = await admin
          .from("cursor_auth_flows")
          .select("id, expires_at")
          .eq("id", flowId)
          .eq("claimed_by", claimToken)
          .in("status", ["processing", "prompted"])
          .gt("expires_at", new Date().toISOString())
          .maybeSingle();
        if (flow.error) throw new Error("Could not load Cursor sign-in.");
        if (flow.data) await processClaimedCursorAuthFlow(admin, flow.data, claimToken);
      },
    );
    await step.do("wake dispatcher", () => dispatcher(this.env).kick());
  }
}

export class MaintenanceWorkflow extends WorkflowEntrypoint<Env, { tick: number }> {
  async run(_event: WorkflowEvent<{ tick: number }>, step: WorkflowStep) {
    const admin = createSupabaseAdminClient();
    const tasks = [
      [
        "queue health",
        async () => {
          const [queue, source] = await Promise.all([
            admin
              .from("agent_jobs")
              .select("created_at", { count: "exact" })
              .eq("status", "queued")
              .order("created_at")
              .limit(1),
            admin
              .from("session_source_deliveries")
              .select("run_id", { count: "exact", head: true })
              .in("status", ["pending", "claimed"]),
          ]);
          if (queue.error || source.error) throw new Error("Could not inspect queue health.");
          console.log("[cloudflare-maintenance] queue health", {
            queuedJobs: queue.count ?? 0,
            oldestQueueAgeMs: queue.data?.[0]
              ? Math.max(0, Date.now() - Date.parse(queue.data[0].created_at))
              : 0,
            pendingSourceDeliveries: source.count ?? 0,
          });
        },
      ],
      ["checkpoint publication", () => drainCheckpointPublications(admin)],
      ["accepted triage route", () => drainAcceptedTriageRoute(admin)],
      ["canonical PR", () => drainCanonicalPullRequests(admin)],
      ["GitHub PR verification", () => reconcileGitHubPrVerification(admin)],
      [
        "PR readiness",
        async () => {
          const result = await reconcilePrReadiness(admin);
          console.log("[cloudflare-maintenance] PR readiness", result);
        },
      ],
      ["stall recovery", () => sweepStalledRuns(admin, 900_000)],
      ["benchmark schedules", () => reconcileBenchmarkSchedules(admin)],
      ["benchmark evaluations", () => reconcileBenchmarkEvaluations(admin)],
      ["source delivery", () => drainSourceDeliveries(admin)],
      ["checkpoint cleanup", () => drainCheckpointCleanup(admin)],
      ["workflow sandbox stops", () => drainFactoryWorkflowSandboxStops(admin)],
      ["Linear reconciliation", () => reconcileLinearState(admin)],
      ["sandbox reaping", () => reapOrphanSandboxes(admin)],
      ["attachment cleanup", () => cleanupExpiredSessionAttachments(admin)],
      ["run retention", () => drainRunRetention(admin)],
      ["OAuth credential cleanup", () => pruneFactoryOAuthCredentials(admin)],
      ["factory command cleanup", () => pruneFactoryCommandAdmissions(admin)],
      ["factory event delivery", () => requestFactoryEventDispatch(this.env)],
      ["factory event outbox cleanup", () => pruneFactoryEventOutbox(admin)],
      ["workspace cleanup", () => resumePendingWorkspaceDeletions(admin)],
      ["factory flow projection", () => processFactoryFlowProjection(admin)],
      ["factory scorer sampling", () => processFactoryScorerSampling(admin)],
      ["factory evaluation queue", () => maintainFactoryEvaluationQueue(admin)],
      ["factory failure cohorts", () => processFactoryFailureCohorts(admin)],
      ["routing canary alerts", () => processFactoryRoutingCanaryAlerts(admin)],
      ["analytics export cleanup", () => pruneFactoryAnalyticsExports(admin)],
      ["run exports", () => drainRunExports(admin)],
      ["run export cleanup", () => cleanupRunExports(admin)],
    ] as const;
    for (const [name, task] of tasks) {
      try {
        await step.do(
          name,
          { timeout: "5 minutes", retries: { limit: 0, delay: "1 second" } },
          async () => {
            await task();
          },
        );
      } catch {
        console.warn("[cloudflare-maintenance] task will retry next cycle", { task: name });
      }
    }
    await step.do("wake dispatcher", () => dispatcher(this.env).kick());
    try {
      await step.do(
        "run factory judges",
        { timeout: "2 minutes", retries: { limit: 0, delay: "1 second" } },
        () => drainFactoryJudges(admin, "workerd"),
      );
    } catch {
      console.warn("[cloudflare-maintenance] task will retry next cycle", {
        task: "factory judges",
      });
    }
    try {
      await step.do(
        "run factory diagnosis",
        { timeout: "2 minutes", retries: { limit: 0, delay: "1 second" } },
        () => drainFactoryDiagnoses(admin, "workerd"),
      );
    } catch {
      console.warn("[cloudflare-maintenance] task will retry next cycle", {
        task: "factory diagnosis",
      });
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname !== "/internal/wake") return new Response(null, { status: 404 });
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
    const expected = Buffer.from(`Bearer ${env.WALLIE_WORKER_WAKE_SECRET ?? ""}`);
    if (
      !env.WALLIE_WORKER_WAKE_SECRET ||
      env.WALLIE_WORKER_WAKE_SECRET.length < 32 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return new Response(null, { status: 401 });
    if (enabled(env)) await dispatcher(env).kick();
    return new Response(null, { status: 202 });
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    if (enabled(env)) await dispatcher(env).kick();
  },
} satisfies ExportedHandler<Env>;
