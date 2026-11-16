import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export type FactoryDefinitionTarget = { kind: "draft" | "revision"; id: string };
type AdminClient = SupabaseClient<Database>;

export function selectDefaultFactory(admin: Pick<AdminClient, "from">, workspaceId: string) {
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
  const query =
    target.kind === "draft"
      ? admin
          .from("factory_definition_drafts")
          .select("definition_json, canonical_digest, settings_metadata")
      : admin.from("factory_definition_revisions").select("definition_json, canonical_digest");
  return query
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", target.id)
    .maybeSingle();
}
