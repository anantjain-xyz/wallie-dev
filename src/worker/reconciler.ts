import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { decryptSecretValue } from "@/lib/secrets/crypto";

type AdminClient = SupabaseClient<Database>;
type SessionRow = {
  id: string;
  workspace_id: string;
  linear_issue_id: string | null;
  phase_status: string;
  created_at: string;
};

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/** Linear states that indicate the issue is no longer active. */
const TERMINAL_LINEAR_STATES = new Set(["canceled", "done", "duplicate"]);

/** Session phase states where Wallie may still do more work. */
const RECONCILABLE_PHASE_STATUSES = ["agent_generating", "awaiting_review", "rejected"] as const;

/** Agent job states that are not yet terminal and may still consume work. */
const ACTIVE_AGENT_JOB_STATUSES = ["queued", "running"] as const;

/** Page size for the reconciliation cursor. */
const RECONCILE_PAGE_SIZE = 50;

/** Backoff floor when Linear signals a rate limit but no Retry-After is present. */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;

/** Cap any honored Retry-After so a hostile/buggy header can't pause the worker forever. */
const MAX_RATE_LIMIT_BACKOFF_MS = 30_000;

export interface ReconcileResult {
  checked: number;
  canceled: number;
  /** True if the sweep aborted early because Linear stayed rate-limited after a retry. */
  rateLimited: boolean;
}

export interface ReconcileOptions {
  /** Sleep function — overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

class RateLimitedError extends Error {
  constructor() {
    super("Linear rate limit persisted after retry");
    this.name = "RateLimitedError";
  }
}

/**
 * Reconciliation sweep: for every active session that was triggered from a
 * Linear issue, check whether the Linear issue is still in an active state.
 * If the issue has been canceled/done/duplicate, stop the Wallie session by
 * marking active jobs as canceled and transitioning the session to rejected.
 *
 * Sessions are grouped by workspace and queried in a single GraphQL `issues`
 * batch per workspace, so a workspace with N active sessions costs one
 * Linear request per page rather than N. The batch fetch honors Linear's
 * `429` and GraphQL `RATELIMITED` envelope: it sleeps for the `Retry-After`
 * (capped) and retries once. If still throttled, the sweep aborts and the
 * cursor stays put — the next reconcile tick will resume from the same row.
 */
export async function reconcileLinearState(
  admin: AdminClient,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const sleep = options.sleep ?? defaultSleep;
  const result: ReconcileResult = { checked: 0, canceled: 0, rateLimited: false };

  let cursor: string | null = null;

  pages: for (;;) {
    let query = admin
      .from("sessions")
      .select("id, workspace_id, linear_issue_id, phase_status, created_at")
      .not("linear_issue_id", "is", null)
      .in("phase_status", RECONCILABLE_PHASE_STATUSES)
      .order("created_at", { ascending: true })
      .limit(RECONCILE_PAGE_SIZE);

    if (cursor) {
      query = query.gt("created_at", cursor);
    }

    const { data: sessions, error: sessionsError } = await query;

    if (sessionsError) {
      console.error("[reconciler] failed to fetch sessions", { error: sessionsError.message });
      break;
    }

    if (!sessions || sessions.length === 0) {
      break;
    }

    // Group sessions by workspace, then by Linear issue ID. Multiple sessions
    // can reference the same issue, so the value is a list.
    const byWorkspace = new Map<string, Map<string, SessionRow[]>>();
    for (const session of sessions as SessionRow[]) {
      if (!session.linear_issue_id) continue;
      let workspaceMap = byWorkspace.get(session.workspace_id);
      if (!workspaceMap) {
        workspaceMap = new Map();
        byWorkspace.set(session.workspace_id, workspaceMap);
      }
      const list = workspaceMap.get(session.linear_issue_id);
      if (list) {
        list.push(session);
      } else {
        workspaceMap.set(session.linear_issue_id, [session]);
      }
    }

    const apiKeys = await loadLinearApiKeys(admin, [...byWorkspace.keys()]);

    for (const [workspaceId, issueMap] of byWorkspace) {
      const apiKey = apiKeys.get(workspaceId);
      if (!apiKey) continue;

      const issueIds = [...issueMap.keys()];
      let issueStates: Map<string, string>;
      try {
        issueStates = await fetchLinearIssueStatesBatch(apiKey, issueIds, sleep);
      } catch (error) {
        if (error instanceof RateLimitedError) {
          console.warn("[reconciler] aborting sweep — Linear rate limit persisted after retry", {
            workspaceId,
          });
          result.rateLimited = true;
          break pages;
        }
        console.error("[reconciler] Linear batch fetch failed", {
          error: error instanceof Error ? error.message : String(error),
          workspaceId,
        });
        continue;
      }

      for (const [issueId, sessionsForIssue] of issueMap) {
        const state = issueStates.get(issueId);
        for (const session of sessionsForIssue) {
          result.checked++;
          if (!state) continue;
          if (!TERMINAL_LINEAR_STATES.has(state.toLowerCase())) continue;

          try {
            await cancelSessionForTerminalIssue(admin, session, state);
            result.canceled++;
          } catch (error) {
            // A transient Supabase write failure must not abort the sweep —
            // log and move on so the remaining sessions still get checked.
            console.error("[reconciler] failed to cancel session for terminal issue", {
              error: error instanceof Error ? error.message : String(error),
              linearIssueId: session.linear_issue_id,
              sessionId: session.id,
            });
          }
        }
      }
    }

    cursor = sessions[sessions.length - 1]!.created_at;

    if (sessions.length < RECONCILE_PAGE_SIZE) {
      break;
    }
  }

  return result;
}

async function cancelSessionForTerminalIssue(
  admin: AdminClient,
  session: SessionRow,
  state: string,
): Promise<void> {
  console.log("[reconciler] Linear issue is terminal, canceling session", {
    linearIssueId: session.linear_issue_id,
    linearState: state,
    sessionId: session.id,
  });

  await admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      last_error: `Linear issue moved to "${state}" — session canceled by reconciler.`,
      status: "canceled",
    })
    .eq("session_id", session.id)
    .in("status", ACTIVE_AGENT_JOB_STATUSES);

  const { data: jobIds } = await admin.from("agent_jobs").select("id").eq("session_id", session.id);

  if (jobIds && jobIds.length > 0) {
    await admin
      .from("agent_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "canceled" as const,
      })
      .in(
        "agent_job_id",
        jobIds.map((j) => j.id),
      )
      .in("status", ["queued", "started", "running"]);
  }

  await admin
    .from("sessions")
    .update({ phase_status: "rejected" })
    .eq("id", session.id)
    .in("phase_status", RECONCILABLE_PHASE_STATUSES);
}

// --- helpers ---

async function loadLinearApiKeys(
  admin: AdminClient,
  workspaceIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (workspaceIds.length === 0) return result;

  const { data, error } = await admin
    .from("workspace_secrets")
    .select("workspace_id, encrypted_value")
    .in("workspace_id", workspaceIds)
    .eq("key", "LINEAR_API_KEY");

  if (error) {
    console.error("[reconciler] failed to load Linear API keys", { error: error.message });
    return result;
  }

  for (const row of data ?? []) {
    try {
      result.set(row.workspace_id, decryptSecretValue(row.encrypted_value));
    } catch {
      // Decryption failed — skip this workspace.
    }
  }

  return result;
}

const issueStatesQuery = /* GraphQL */ `
  query IssueStates($ids: [ID!]) {
    issues(filter: { id: { in: $ids } }, first: 250) {
      nodes {
        id
        state {
          type
        }
      }
    }
  }
`;

type LinearIssueStatesResponse = {
  data?: {
    issues?: {
      nodes?: Array<{ id: string; state?: { type?: string } | null }>;
    } | null;
  };
  errors?: Array<{
    message: string;
    extensions?: { code?: string };
  }>;
};

async function fetchLinearIssueStatesBatch(
  apiKey: string,
  issueIds: string[],
  sleep: (ms: number) => Promise<void>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (issueIds.length === 0) return result;

  let attempt = 0;
  for (;;) {
    const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      body: JSON.stringify({
        query: issueStatesQuery,
        variables: { ids: issueIds },
      }),
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (response.status === 429) {
      if (attempt >= 1) throw new RateLimitedError();
      attempt++;
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      console.warn("[reconciler] Linear returned 429, sleeping before retry", { retryAfterMs });
      await sleep(retryAfterMs);
      continue;
    }

    if (!response.ok) {
      console.error("[reconciler] Linear batch query failed", { status: response.status });
      return result;
    }

    const payload = (await response.json()) as LinearIssueStatesResponse;

    if (payload.errors?.length) {
      const rateLimited = payload.errors.some((e) => e.extensions?.code === "RATELIMITED");
      if (rateLimited) {
        if (attempt >= 1) throw new RateLimitedError();
        attempt++;
        const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
        console.warn("[reconciler] Linear returned RATELIMITED, sleeping before retry", {
          retryAfterMs,
        });
        await sleep(retryAfterMs);
        continue;
      }
      console.error("[reconciler] Linear batch query returned errors", {
        errors: payload.errors.map((e) => e.message),
      });
      return result;
    }

    for (const node of payload.data?.issues?.nodes ?? []) {
      const stateType = node.state?.type;
      if (stateType) result.set(node.id, stateType);
    }
    return result;
  }
}

function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const seconds = Number.parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const ms = Math.min(seconds * 1000, MAX_RATE_LIMIT_BACKOFF_MS);
  return Math.max(ms, DEFAULT_RATE_LIMIT_BACKOFF_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
