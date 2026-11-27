import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isWorkspaceOperator } from "@/features/workspaces/authenticated-context";
import {
  workspaceFactoryDefinitionPath,
  workspaceOnboardingPath,
  workspaceSettingsPath,
} from "@/lib/routes";
import type { Database } from "@/lib/supabase/database.types";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";

type Member = WorkspaceAccessContext["currentMember"];

export async function loadBrowserSessionFactories({
  supabase,
  workspaceId,
  member,
  factoryId,
  defaultOnly = false,
}: {
  supabase: Pick<SupabaseClient<Database>, "from">;
  workspaceId: string;
  member: Member;
  factoryId?: string;
  defaultOnly?: boolean;
}) {
  if (!member.is_active || member.kind !== "human") return [];
  let query = supabase
    .from("factories")
    .select(
      "id, name, status, is_default, factory_members!factory_members_workspace_factory_fkey(id)",
    )
    .eq("workspace_id", workspaceId)
    .eq("factory_members.member_id", member.id)
    .is("factory_members.revoked_at", null);
  if (factoryId) query = query.eq("id", factoryId);
  else if (defaultOnly) query = query.eq("is_default", true);
  else query = query.eq("status", "active");
  const { data, error } = await query.order("name").order("id");
  if (error) throw error;

  const operator = isWorkspaceOperator(member);
  return (data ?? [])
    .filter((factory) => operator || factory.factory_members.length > 0)
    .map(({ id, name, status, is_default }) => ({ id, name, status, isDefault: is_default }));
}

export function browserSessionSetupHref(
  code: string | undefined,
  input: { factoryId: string; member: Member; workspaceSlug: string },
) {
  const { factoryId, member, workspaceSlug } = input;
  if (code === "factory_credential_unavailable") {
    return `${workspaceSettingsPath(workspaceSlug, { category: "integrations" })}#provider-access`;
  }
  if (!isWorkspaceOperator(member)) return undefined;

  switch (code) {
    case "factory_definition_required":
    case "factory_execution_unready":
    case "factory_profile_unavailable":
    case "factory_repository_unavailable":
      return `${workspaceFactoryDefinitionPath(workspaceSlug, { factory: factoryId })}#factory-setup`;
    case "factory_pipeline_unavailable":
      return `${workspaceSettingsPath(workspaceSlug, { category: "integrations", factory: factoryId })}#factory-configuration`;
    case "sandbox_capability_check_stale":
    case "sandbox_connection_missing":
    case "sandbox_connection_invalid":
      return workspaceSettingsPath(workspaceSlug, { category: "integrations" });
    case "workspace_setup_required":
      return workspaceOnboardingPath(workspaceSlug);
    default:
      return undefined;
  }
}
