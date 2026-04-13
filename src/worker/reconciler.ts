import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { decryptSecretValue } from "@/lib/secrets/crypto";

type AdminClient = SupabaseClient<Database>;

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/** Linear states that indicate the issue is no longer active. */
const TERMINAL_LINEAR_STATES = new Set(["canceled", "done", "duplicate"]);

export interface ReconcileResult {
  checked: number;
  canceled: number;
}

/**
 * Reconciliation sweep: for every running session that was triggered from a
 * Linear issue, check whether the Linear issue is still in an active state.
 * If the issue has been canceled/done/duplicate, stop the Wallie session by
 * marking the running job as canceled and transitioning the session to
 * rejected.
 */
/** Page size for the reconciliation cursor. */
const RECONCILE_PAGE_SIZE = 50;

export async function reconcileLinearState(admin: AdminClient): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, canceled: 0 };

  // Paginate through all agent_generating sessions with a Linear issue.
  // Use created_at cursor to ensure every session is eventually checked,
  // even if there are more than one page.
  let cursor: string | null = null;

  for (;;) {
    let query = admin
      .from("sessions")
      .select("id, workspace_id, linear_issue_id, phase_status, created_at")
      .not("linear_issue_id", "is", null)
      .eq("phase_status", "agent_generating")
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

    // Load Linear API keys per workspace for this page.
    const workspaceIds = [...new Set(sessions.map((s) => s.workspace_id))];
    const apiKeys = await loadLinearApiKeys(admin, workspaceIds);

    for (const session of sessions) {
      const apiKey = apiKeys.get(session.workspace_id);
      if (!apiKey || !session.linear_issue_id) continue;

      result.checked++;

      try {
        const state = await fetchLinearIssueState(apiKey, session.linear_issue_id);
        if (!state) continue;

        const stateLower = state.toLowerCase();
        if (!TERMINAL_LINEAR_STATES.has(stateLower)) continue;

        // Issue is terminal in Linear — cancel the Wallie session.
        console.log("[reconciler] Linear issue is terminal, canceling session", {
          linearIssueId: session.linear_issue_id,
          linearState: state,
          sessionId: session.id,
        });

        // Cancel any running jobs for this session.
        await admin
          .from("agent_jobs")
          .update({
            finished_at: new Date().toISOString(),
            last_error: `Linear issue moved to "${state}" — session canceled by reconciler.`,
            status: "canceled",
          })
          .eq("session_id", session.id)
          .eq("status", "running");

        // Cancel any active agent runs for this session's jobs.
        const { data: jobIds } = await admin
          .from("agent_jobs")
          .select("id")
          .eq("session_id", session.id);

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

        // Move session out of agent_generating.
        await admin
          .from("sessions")
          .update({ phase_status: "rejected" })
          .eq("id", session.id)
          .eq("phase_status", "agent_generating");

        result.canceled++;
      } catch (error) {
        console.error("[reconciler] failed to check Linear issue", {
          error: error instanceof Error ? error.message : String(error),
          linearIssueId: session.linear_issue_id,
          sessionId: session.id,
        });
      }
    }

    // Advance cursor to last row's created_at for next page.
    cursor = sessions[sessions.length - 1]!.created_at;

    // If we got fewer rows than the page size, we've reached the end.
    if (sessions.length < RECONCILE_PAGE_SIZE) {
      break;
    }
  }

  return result;
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

type LinearIssueStateResponse = {
  data?: {
    issue?: {
      state?: { type?: string } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

const issueStateQuery = /* GraphQL */ `
  query IssueState($id: String!) {
    issue(id: $id) {
      state {
        type
      }
    }
  }
`;

async function fetchLinearIssueState(apiKey: string, issueId: string): Promise<string | null> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    body: JSON.stringify({
      query: issueStateQuery,
      variables: { id: issueId },
    }),
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as LinearIssueStateResponse;
  return payload.data?.issue?.state?.type ?? null;
}
