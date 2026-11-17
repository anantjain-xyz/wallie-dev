import "server-only";

import { cache } from "react";

import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

export const loadWorkspaceFactoryOptions = cache(
  async (workspaceSlug: string): Promise<FactorySelectionOption[]> => {
    const { supabase, workspace } = await loadAuthenticatedWorkspaceContext(workspaceSlug);
    const { data, error } = await supabase
      .from("factories")
      .select("id, name, is_default, status")
      .eq("workspace_id", workspace.id)
      .order("is_default", { ascending: false })
      .order("name")
      .order("id");
    if (error) throw error;
    return data.map((factory) => ({
      id: factory.id,
      name: factory.name,
      isDefault: factory.is_default,
      status: factory.status === "archived" ? "archived" : "active",
    }));
  },
);
