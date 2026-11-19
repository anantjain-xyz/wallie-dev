import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export type FactoryEditorSkillReferenceOption = { id: string; label: string };
export type FactoryEditorScorerReferenceOption = { id: string; label: string };
export type FactoryEditorToolReferenceOption = { id: string; label: string; operations: string[] };
export type FactoryEditorReferenceOptions = {
  skills: FactoryEditorSkillReferenceOption[];
  scorers: FactoryEditorScorerReferenceOption[];
  tools: FactoryEditorToolReferenceOption[];
};

const suggestionLimit = 100;

export async function loadFactoryEditorReferenceOptions(
  client: Pick<SupabaseClient<Database>, "from">,
  workspaceId: string,
  factoryId: string,
  requestedScorerRevisionId?: string,
): Promise<FactoryEditorReferenceOptions> {
  const scorerQuery = () =>
    client
      .from("factory_scorer_revisions")
      .select("id, revision_number, factory_scorers!inner(name)")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId);
  const [skills, scorers, requestedScorer, tools] = await Promise.all([
    client
      .from("factory_skill_revisions")
      .select("id, revision_number, factory_skills!inner(name)")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(suggestionLimit),
    scorerQuery().order("created_at", { ascending: false }).order("id").limit(suggestionLimit),
    requestedScorerRevisionId
      ? scorerQuery().eq("id", requestedScorerRevisionId).maybeSingle()
      : { data: null, error: null },
    client
      .from("factory_mcp_server_revisions")
      .select("id, revision_number, operation_names, factory_mcp_servers!inner(name)")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(suggestionLimit),
  ]);
  if (skills.error) throw skills.error;
  if (scorers.error) throw scorers.error;
  if (requestedScorer.error) throw requestedScorer.error;
  if (tools.error) throw tools.error;
  const scorerRows = scorers.data;
  if (requestedScorer.data && !scorerRows.some(({ id }) => id === requestedScorer.data?.id)) {
    scorerRows.push(requestedScorer.data);
  }
  return {
    skills: skills.data.map((row) => ({
      id: row.id,
      label: `${row.factory_skills.name} · Revision ${row.revision_number}`,
    })),
    scorers: scorerRows.map((row) => ({
      id: row.id,
      label: `${row.factory_scorers.name} · Revision ${row.revision_number}`,
    })),
    tools: tools.data.map((row) => ({
      id: row.id,
      label: `${row.factory_mcp_servers.name} · Revision ${row.revision_number}`,
      operations: row.operation_names,
    })),
  };
}
