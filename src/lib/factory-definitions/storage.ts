import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export type FactoryDefinitionTarget = { kind: "draft" | "revision"; id: string };
type AdminClient = SupabaseClient<Database>;

export function selectDefaultFactory(admin: Pick<AdminClient, "from">, workspaceId: string) {
  return selectFactory(admin, workspaceId);
}

export function selectFactory(
  client: Pick<AdminClient, "from">,
  workspaceId: string,
  factoryId?: string,
) {
  const query = client
    .from("factories")
    .select("id, name, is_default")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  return (
    factoryId === undefined ? query.eq("is_default", true) : query.eq("id", factoryId)
  ).maybeSingle();
}

export function selectFactoryBaselinePipeline(
  client: Pick<AdminClient, "from">,
  workspaceId: string,
  factory: { id: string; is_default: boolean },
) {
  const columns = "id, name, is_default, operating_rules_md";
  const pipelines = client.from("pipelines");
  if (factory.is_default) {
    return pipelines
      .select(columns)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .eq("is_default", true)
      .maybeSingle();
  }
  return pipelines
    .select(`${columns}, pipeline_stages()`)
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factory.id)
    .is("pipeline_stages.archived_at", null)
    .not("pipeline_stages", "is", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
}

export function selectCurrentFactoryActivation(
  client: Pick<AdminClient, "from">,
  workspaceId: string,
  factoryId: string,
) {
  return client
    .from("factory_definition_activations")
    .select("activation_number, revision_id")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("activation_number", { ascending: false })
    .limit(1)
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
          .select(
            "id, definition_json, canonical_digest, settings_metadata, created_at, routing_evidence_source_draft_id",
          )
      : admin
          .from("factory_definition_revisions")
          .select("id, definition_json, canonical_digest, source_draft_id, created_at");
  return query
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", target.id)
    .maybeSingle();
}
