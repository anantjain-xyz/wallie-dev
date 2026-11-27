import "server-only";

import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

export type SessionBrowseFactory = Pick<FactorySelectionOption, "id" | "name" | "status">;

export async function loadBrowsePipelineOwners(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  workspaceId: string,
  pipelineIds: readonly string[],
): Promise<Map<string, SessionBrowseFactory>> {
  const ids = [...new Set(pipelineIds)];
  const queries = [];
  for (let start = 0; start < ids.length; start += 100) {
    queries.push(
      supabase
        .from("pipelines")
        .select("id, factory:factories!pipelines_workspace_factory_fkey(id, name, status)")
        .eq("workspace_id", workspaceId)
        .in("id", ids.slice(start, start + 100)),
    );
  }
  const owners = new Map<string, SessionBrowseFactory>();
  for (const { data, error } of await Promise.all(queries)) {
    if (error) throw error;
    for (const { id, factory } of data ?? []) {
      if (!factory) continue;
      owners.set(id, {
        id: factory.id,
        name: factory.name,
        status: factory.status === "archived" ? "archived" : "active",
      });
    }
  }
  return owners;
}
