import "server-only";

import { notFound, redirect } from "next/navigation";

import type { WorkspaceSummary } from "@/lib/auth";
import { getWorkspaceBySlugForUser, workspaceLoginRedirectPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildWorkspaceMemberIndex,
  mapWorkspaceMemberRow,
  mapWorkspaceViewerMemberRow,
} from "@/features/workspace-members/model";
import type {
  WorkspaceMember,
  WorkspaceMemberRow,
  WorkspaceViewerMember,
  WorkspaceViewerMemberRow,
} from "@/features/workspace-members/types";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

const memberSelect = "id, full_name, username, avatar_url, role, kind, user_id, is_active";
const viewerMemberSelect = `${memberSelect}, preferences`;

export type WorkspaceMemberContext = {
  currentMember: WorkspaceViewerMember | null;
  memberIndex: Map<string, WorkspaceMember>;
  members: WorkspaceMember[];
  supabase: SupabaseServerClient;
  workspace: WorkspaceSummary;
};

export async function loadWorkspaceMemberContext(
  workspaceSlug: string,
): Promise<WorkspaceMemberContext> {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    redirect(loginPath(workspaceLoginRedirectPath(workspaceSlug)));
  }

  const workspace = await getWorkspaceBySlugForUser(supabase, workspaceSlug);

  if (!workspace) {
    notFound();
  }

  const [
    { data: membersData, error: membersError },
    { data: currentMemberData, error: currentMemberError },
  ] = await Promise.all([
    supabase
      .from("workspace_members")
      .select(memberSelect)
      .eq("workspace_id", workspace.id)
      .order("kind", { ascending: true })
      .order("full_name", { ascending: true }),
    supabase
      .from("workspace_members")
      .select(viewerMemberSelect)
      .eq("workspace_id", workspace.id)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (membersError) {
    throw membersError;
  }

  if (currentMemberError) {
    throw currentMemberError;
  }

  const members = ((membersData ?? []) as WorkspaceMemberRow[]).map(mapWorkspaceMemberRow);
  const memberIndex = buildWorkspaceMemberIndex(members);
  const currentMember = currentMemberData
    ? mapWorkspaceViewerMemberRow(currentMemberData as WorkspaceViewerMemberRow)
    : null;

  if (currentMember && !memberIndex.has(currentMember.id)) {
    memberIndex.set(currentMember.id, currentMember);
    members.push(currentMember);
  }

  return {
    currentMember,
    memberIndex,
    members,
    supabase,
    workspace,
  };
}
