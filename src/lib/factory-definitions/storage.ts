import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export type FactoryDefinitionTarget = { kind: "draft" | "revision"; id: string };
type AdminClient = SupabaseClient<Database>;

export function selectDefaultFactory(admin: AdminClient, workspaceId: string) {
  return admin
    .from("factories")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .maybeSingle();
}

export function selectStoredFactoryDefinition(
  admin: AdminClient,
  workspaceId: string,
  factoryId: string,
  target: FactoryDefinitionTarget,
) {
  return admin
    .from(target.kind === "draft" ? "factory_definition_drafts" : "factory_definition_revisions")
    .select("definition_json, canonical_digest")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", target.id)
    .maybeSingle();
}
