import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";
import { WALLIE_REQUIRED_SECRET_KEYS } from "@/lib/wallie/constants";
import { buildWallieIssueData } from "@/features/wallie/data";
import type { WallieIssueRepository } from "@/features/wallie/types";
import type { IssueMember } from "@/features/issues/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export async function loadWallieIssueData(input: {
  issue: Pick<Tables<"issues">, "github_repository_id" | "id">;
  memberIndex: ReadonlyMap<string, IssueMember>;
  repository: WallieIssueRepository | null;
  supabase: SupabaseServerClient;
  workspaceId: string;
}) {
  const admin = createSupabaseAdminClient();
  const [
    { data: runRows, error: runError },
    { data: workspace, error: workspaceError },
    { data: secretRows, error: secretError },
  ] = await Promise.all([
    input.supabase
      .from("agent_runs")
      .select(runSelect)
      .eq("issue_id", input.issue.id)
      .order("created_at", { ascending: false }),
    input.supabase
      .from("workspaces")
      .select("tier, current_billing_cycle_start_at, successful_agent_runs_this_cycle")
      .eq("id", input.workspaceId)
      .single(),
    admin
      .from("workspace_secrets")
      .select("key")
      .eq("workspace_id", input.workspaceId)
      .in("key", [...WALLIE_REQUIRED_SECRET_KEYS]),
  ]);

  if (runError) {
    throw runError;
  }

  if (workspaceError) {
    throw workspaceError;
  }

  if (secretError) {
    throw secretError;
  }

  const runIds = (runRows ?? []).map((run) => run.id);
  let messageRows: Array<
    Pick<Tables<"agent_run_messages">, "agent_run_id" | "created_at" | "id" | "kind" | "message_md">
  > = [];

  if (runIds.length > 0) {
    const { data, error } = await input.supabase
      .from("agent_run_messages")
      .select("agent_run_id, created_at, id, kind, message_md")
      .in("agent_run_id", runIds)
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    messageRows = (data ?? []) as typeof messageRows;
  }

  const availableSecretKeys = new Set((secretRows ?? []).map((secret) => secret.key));
  const missingSecretKeys = [...WALLIE_REQUIRED_SECRET_KEYS].filter(
    (secretKey) => !availableSecretKeys.has(secretKey),
  );

  return buildWallieIssueData({
    billing: {
      currentBillingCycleStartAt: workspace.current_billing_cycle_start_at,
      successfulRunsThisCycle: workspace.successful_agent_runs_this_cycle,
      tier: workspace.tier,
    },
    issueGithubRepositoryId: input.issue.github_repository_id,
    memberIndex: input.memberIndex,
    messages: messageRows,
    missingSecretKeys,
    repository: input.repository,
    runs: (runRows ?? []) as Array<
      Pick<
        Tables<"agent_runs">,
        | "created_at"
        | "finished_at"
        | "id"
        | "model_name"
        | "model_provider"
        | "run_type"
        | "started_at"
        | "status"
        | "triggered_by_member_id"
      >
    >,
  });
}

const runSelect =
  "id, created_at, finished_at, model_name, model_provider, run_type, started_at, status, triggered_by_member_id";
