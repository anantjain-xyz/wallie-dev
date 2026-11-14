import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { RECOMMENDED_AGENT_CONFIG_DEFAULTS } from "@/lib/agent-config/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Enums, Tables } from "@/lib/supabase/database.types";
import { RUN_CATALOG_MAX_PAGE_SIZE } from "./run-catalog-contracts";

type RecoveryRow = {
  run_id: string;
  session_id: string;
  job_id: string | null;
  attempt_count: number | null;
  status: Enums<"agent_run_status">;
  source_recovery_required: boolean;
  created_at: string;
  last_activity_at: string | null;
};

export type RunCatalogRecovery = {
  metadataAvailable: boolean;
  queue: {
    state: "unclaimed" | "current" | "retry_scheduled" | "superseded" | "unknown";
    status: Enums<"agent_job_status"> | null;
    attemptCount: number | null;
    scheduledAt: string | null;
  };
  publication: {
    status: "pending" | "claimed" | "adopted" | "stale";
    deadlineAt: string;
    deadlineExpired: boolean;
    nextAttemptAt: string;
    attemptCount: number;
    leaseExpiresAt: string | null;
  } | null;
  sourceRecoveryRequired: boolean;
  retryCheckpointAvailable: boolean | null;
  activity: {
    state: "recent" | "stale" | "unknown";
    observedAt: string | null;
    thresholdMs: number;
  };
  worker: {
    state:
      | "unobserved"
      | "dispatch_pending"
      | "dispatched"
      | "execution_started"
      | "deadline_expired"
      | "unknown";
    deadlineAt: string | null;
    dispatchedAt: string | null;
    executionStartedAt: string | null;
  };
};

type Job = Pick<
  Tables<"agent_jobs">,
  "id" | "workspace_id" | "session_id" | "attempt_count" | "status" | "scheduled_at"
>;

function queueFor(row: RecoveryRow, job: Job | undefined): RunCatalogRecovery["queue"] {
  const unknown = {
    state: "unknown",
    status: null,
    attemptCount: null,
    scheduledAt: null,
  } satisfies RunCatalogRecovery["queue"];
  if (!job || job.session_id !== row.session_id) return unknown;
  const state =
    row.attempt_count === null &&
    row.status === "queued" &&
    job.attempt_count === 0 &&
    job.status === "queued"
      ? "unclaimed"
      : row.attempt_count !== null && job.attempt_count > row.attempt_count
        ? "superseded"
        : row.attempt_count !== null && job.attempt_count === row.attempt_count
          ? row.status === "error" && job.status === "queued"
            ? "retry_scheduled"
            : "current"
          : "unknown";
  return state === "unknown"
    ? unknown
    : {
        state,
        status: job.status,
        attemptCount: job.attempt_count,
        scheduledAt: job.scheduled_at,
      };
}

/** Rows must come from the caller's RLS-scoped catalog read; privileged joins never broaden that page. */
export async function loadRunCatalogRecovery(input: {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  rows: readonly RecoveryRow[];
}): Promise<Map<string, RunCatalogRecovery>> {
  const { supabase, workspaceId, rows } = input;
  if (!rows.length) return new Map();
  if (rows.length > RUN_CATALOG_MAX_PAGE_SIZE + 1)
    throw new Error("Run recovery lookup exceeds its page limit.");
  const admin = createSupabaseAdminClient();
  const runIds = [...new Set(rows.map((row) => row.run_id))];
  const jobIds = [...new Set(rows.flatMap((row) => (row.job_id ? [row.job_id] : [])))];
  const [jobs, publications, checkpoints, configuration] = await Promise.all([
    jobIds.length
      ? admin
          .from("agent_jobs")
          .select("id, workspace_id, session_id, attempt_count, status, scheduled_at")
          .eq("workspace_id", workspaceId)
          .in("id", jobIds)
          .limit(jobIds.length)
      : Promise.resolve({ data: [], error: null }),
    admin
      .from("session_checkpoint_publications")
      .select(
        "run_id, workspace_id, session_id, job_id, attempt_count, status, deadline_at, next_attempt_at, publication_attempt_count, lease_expires_at",
      )
      .eq("workspace_id", workspaceId)
      .in("run_id", runIds)
      .limit(runIds.length),
    admin
      .from("session_retry_checkpoints")
      .select("source_run_id, source_attempt_count, workspace_id")
      .eq("workspace_id", workspaceId)
      .in("source_run_id", runIds)
      .limit(runIds.length),
    supabase
      .from("workspace_agent_config")
      .select("value_json")
      .eq("workspace_id", workspaceId)
      .eq("key", "stall_timeout_ms")
      .maybeSingle(),
  ]);
  const jobIndex = new Map(
    (jobs.error ? [] : (jobs.data ?? []))
      .filter((job) => job.workspace_id === workspaceId)
      .map((job) => [job.id, job]),
  );
  const publicationIndex = new Map(
    (publications.error ? [] : (publications.data ?? []))
      .filter((publication) => publication.workspace_id === workspaceId)
      .map((publication) => [publication.run_id, publication]),
  );
  const checkpointIndex = new Map(
    (checkpoints.error ? [] : (checkpoints.data ?? []))
      .filter((checkpoint) => checkpoint.workspace_id === workspaceId)
      .map((checkpoint) => [checkpoint.source_run_id, checkpoint]),
  );
  const currentPairs = rows.flatMap((row) => {
    const job = row.job_id ? jobIndex.get(row.job_id) : undefined;
    return row.attempt_count !== null &&
      job?.attempt_count === row.attempt_count &&
      job.session_id === row.session_id &&
      (job.status === "started" || job.status === "running") &&
      (row.status === "started" || row.status === "running")
      ? [{ jobId: job.id, attemptCount: row.attempt_count }]
      : [];
  });
  const dispatches = currentPairs.length
    ? await admin
        .from("worker_dispatches")
        .select(
          "workspace_id, job_id, attempt_count, deadline_at, dispatched_at, execution_started_at",
        )
        .eq("workspace_id", workspaceId)
        .or(
          currentPairs
            .map((pair) => `and(job_id.eq.${pair.jobId},attempt_count.eq.${pair.attemptCount})`)
            .join(","),
        )
        .limit(currentPairs.length)
    : { data: [], error: null };
  const dispatchIndex = new Map(
    (dispatches.error ? [] : (dispatches.data ?? []))
      .filter((dispatch) => dispatch.workspace_id === workspaceId)
      .map((dispatch) => [`${dispatch.job_id}:${dispatch.attempt_count}`, dispatch]),
  );
  const configured = configuration.data?.value_json;
  const thresholdMs =
    typeof configured === "number" && Number.isInteger(configured) && configured > 0
      ? configured
      : RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms;
  const now = Date.now();
  const metadataAvailable =
    !jobs.error &&
    !publications.error &&
    !checkpoints.error &&
    !configuration.error &&
    !dispatches.error;
  return new Map(
    rows.map((row) => {
      const queue = queueFor(row, row.job_id ? jobIndex.get(row.job_id) : undefined);
      const publication = publicationIndex.get(row.run_id);
      const checkpoint = checkpointIndex.get(row.run_id);
      const dispatch =
        queue.state === "current" && (row.status === "started" || row.status === "running")
          ? dispatchIndex.get(`${row.job_id}:${row.attempt_count}`)
          : undefined;
      const observedAt = row.last_activity_at ?? row.created_at;
      const observedMs = Date.parse(observedAt);
      const active = row.status === "started" || row.status === "running";
      return [
        row.run_id,
        {
          metadataAvailable,
          queue,
          publication:
            publication &&
            row.attempt_count !== null &&
            publication.attempt_count === row.attempt_count &&
            publication.job_id === row.job_id &&
            publication.session_id === row.session_id &&
            (publication.status === "pending" ||
              publication.status === "claimed" ||
              publication.status === "adopted" ||
              publication.status === "stale")
              ? {
                  status: publication.status,
                  deadlineAt: publication.deadline_at,
                  deadlineExpired: Date.parse(publication.deadline_at) <= now,
                  nextAttemptAt: publication.next_attempt_at,
                  attemptCount: publication.publication_attempt_count,
                  leaseExpiresAt: publication.lease_expires_at,
                }
              : null,
          sourceRecoveryRequired: row.source_recovery_required,
          retryCheckpointAvailable: checkpoints.error
            ? null
            : row.attempt_count !== null && checkpoint?.source_attempt_count === row.attempt_count,
          activity: {
            state:
              active && !configuration.error && Number.isFinite(observedMs) && observedMs <= now
                ? now - observedMs >= thresholdMs
                  ? "stale"
                  : "recent"
                : "unknown",
            observedAt: Number.isFinite(observedMs) ? observedAt : null,
            thresholdMs,
          },
          worker: {
            state:
              jobs.error || dispatches.error
                ? "unknown"
                : dispatch
                  ? Date.parse(dispatch.deadline_at) <= now
                    ? "deadline_expired"
                    : dispatch.execution_started_at
                      ? "execution_started"
                      : dispatch.dispatched_at
                        ? "dispatched"
                        : "dispatch_pending"
                  : "unobserved",
            deadlineAt: dispatch?.deadline_at ?? null,
            dispatchedAt: dispatch?.dispatched_at ?? null,
            executionStartedAt: dispatch?.execution_started_at ?? null,
          },
        } satisfies RunCatalogRecovery,
      ];
    }),
  );
}
