import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";
import { WALLIE_REQUIRED_SECRET_KEYS } from "@/lib/wallie/constants";
import { buildWallieSessionData } from "@/features/wallie/data";
import type { WallieSessionRepository } from "@/features/wallie/types";
import type { WorkspaceMember } from "@/features/workspace-members/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export async function loadWallieSessionData(input: {
  session: { githubRepositoryId: string | null; id: string };
  memberIndex: ReadonlyMap<string, WorkspaceMember>;
  repository: WallieSessionRepository | null;
  supabase: SupabaseServerClient;
  workspaceId: string;
}) {
  const admin = createSupabaseAdminClient();
  const runRowsPromise = input.supabase
    .from("agent_runs")
    .select(runSelect)
    .eq("session_id", input.session.id)
    .order("created_at", { ascending: false });
  const secretRowsPromise =
    WALLIE_REQUIRED_SECRET_KEYS.length > 0
      ? admin
          .from("workspace_secrets")
          .select("key")
          .eq("workspace_id", input.workspaceId)
          .in("key", [...WALLIE_REQUIRED_SECRET_KEYS])
      : Promise.resolve({ data: [], error: null });
  const [{ data: runRows, error: runError }, { data: secretRows, error: secretError }] =
    await Promise.all([runRowsPromise, secretRowsPromise]);

  if (runError) {
    throw runError;
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

  return buildWallieSessionData({
    sessionGithubRepositoryId: input.session.githubRepositoryId,
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
        | "stage_id"
        | "stage_name"
        | "stage_slug"
        | "status"
        | "triggered_by_member_id"
      >
    >,
  });
}

const runSelect =
  "id, created_at, finished_at, model_name, model_provider, run_type, stage_id, stage_slug, stage_name, started_at, status, triggered_by_member_id";
