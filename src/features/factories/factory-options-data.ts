import "server-only";

import { cache } from "react";

import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";

export const loadWorkspaceFactoryOptions = cache(
  async (workspaceSlug: string): Promise<FactorySelectionOption[]> => {
    const { currentMember, supabase, workspace } =
      await loadAuthenticatedWorkspaceContext(workspaceSlug);
    const { data, error } = await supabase
      .from("factories")
      .select(
        "id, name, slug, is_default, status, factory_members!factory_members_workspace_factory_fkey(role)",
      )
      .eq("workspace_id", workspace.id)
      .eq("factory_members.member_id", currentMember.id)
      .eq("factory_members.role", "manager")
      .is("factory_members.revoked_at", null)
      .order("is_default", { ascending: false })
      .order("name")
      .order("id");
    if (error) throw error;
    const workspaceOperator = isWorkspaceOperator(currentMember);
    const activeHuman = currentMember.kind === "human" && currentMember.is_active;
    return data.map((factory) => ({
      canManage: workspaceOperator || (activeHuman && factory.factory_members.length > 0),
      id: factory.id,
      name: factory.name,
      slug: factory.slug,
      isDefault: factory.is_default,
      status: factory.status === "archived" ? "archived" : "active",
    }));
  },
);
