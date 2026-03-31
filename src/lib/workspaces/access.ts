import "server-only";

import type { User } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

const workspaceSelect =
  "id, name, slug, avatar_path, tier, stripe_customer_id, current_billing_cycle_start_at, successful_agent_runs_this_cycle, created_at, updated_at";
const memberSelect = "id, role, is_active, kind";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type WorkspaceAccessContext = {
  currentMember: Pick<
    Tables<"workspace_members">,
    "id" | "is_active" | "kind" | "role"
  >;
  supabase: SupabaseServerClient;
  user: User;
  workspace: Pick<
    Tables<"workspaces">,
    | "avatar_path"
    | "created_at"
    | "current_billing_cycle_start_at"
    | "id"
    | "name"
    | "slug"
    | "stripe_customer_id"
    | "successful_agent_runs_this_cycle"
    | "tier"
    | "updated_at"
  >;
};

type WorkspaceAccessFailure = {
  error: string;
  status: 400 | 401 | 403 | 404;
};

type WorkspaceAccessSuccess = {
  context: WorkspaceAccessContext;
  ok: true;
};

type WorkspaceAccessResult =
  | WorkspaceAccessSuccess
  | (WorkspaceAccessFailure & {
      ok: false;
    });

async function loadCurrentUser(supabase: SupabaseServerClient) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

export async function requireWorkspaceAccessById(
  workspaceId: string | null | undefined,
  options?: {
    requireManager?: boolean;
  },
): Promise<WorkspaceAccessResult> {
  if (!workspaceId) {
    return {
      error: "Workspace id is required.",
      ok: false,
      status: 400,
    };
  }

  const supabase = await createSupabaseServerClient();
  const user = await loadCurrentUser(supabase);

  if (!user) {
    return {
      error: "Sign in before managing workspace settings.",
      ok: false,
      status: 401,
    };
  }

  const [{ data: workspace, error: workspaceError }, { data: currentMember, error: memberError }] =
    await Promise.all([
      supabase
        .from("workspaces")
        .select(workspaceSelect)
        .eq("id", workspaceId)
        .maybeSingle(),
      supabase
        .from("workspace_members")
        .select(memberSelect)
        .eq("workspace_id", workspaceId)
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

  if (workspaceError) {
    throw workspaceError;
  }

  if (memberError) {
    throw memberError;
  }

  if (!workspace || !currentMember || !currentMember.is_active) {
    return {
      error: "Workspace not found.",
      ok: false,
      status: 404,
    };
  }

  if (currentMember.kind !== "human") {
    return {
      error: "Only human workspace members can use this route.",
      ok: false,
      status: 403,
    };
  }

  if (
    options?.requireManager &&
    currentMember.role !== "owner" &&
    currentMember.role !== "admin"
  ) {
    return {
      error: "Workspace admin access is required for this action.",
      ok: false,
      status: 403,
    };
  }

  return {
    context: {
      currentMember,
      supabase,
      user,
      workspace,
    },
    ok: true,
  };
}
