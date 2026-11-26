import "server-only";

import type { createSupabaseServerClient } from "@/lib/supabase/server";
import type { RunCatalogQuery } from "./run-catalog-contracts";

type Scope = {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  factoryId?: string;
};

export type RunSessionOption = { id: string; label: string; factoryName?: string };
export type RunStageOption = { id: string; label: string };

export async function loadRunSessionOptions(
  { supabase, workspaceId, factoryId }: Scope,
  input: { sessionId: string } | { search: string },
): Promise<RunSessionOption[]> {
  let query = supabase
    .from("sessions")
    .select("id, number, title, factories!sessions_workspace_factory_fkey!inner(name)")
    .eq("workspace_id", workspaceId)
    .eq("execution_purpose", "production");
  if (factoryId) query = query.eq("factory_id", factoryId);
  if ("sessionId" in input) {
    query = query.eq("id", input.sessionId);
  } else if (/^#?\d+$/.test(input.search)) {
    const number = Number(input.search.replace(/^#/, ""));
    if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) return [];
    query = query.eq("number", number);
  } else if (input.search) {
    query = query.ilike("title", `%${input.search.replace(/[\\%_]/g, "\\$&")}%`);
  }
  const { data, error } = await query.order("number", { ascending: false }).limit(12);
  if (error) throw error;
  return data.map((row) => ({
    id: row.id,
    label: `#${row.number} ${row.title.slice(0, 200)}`,
    ...(factoryId ? {} : { factoryName: row.factories.name }),
  }));
}

export async function loadRunStageOptions({
  supabase,
  workspaceId,
  factoryId,
}: Scope): Promise<RunStageOption[]> {
  const options: RunStageOption[] = [];
  for (let start = 0; ; start += 250) {
    let query = supabase
      .from("pipeline_stages")
      .select("id, name, archived_at, pipelines!inner(name, factory_id, factories!inner(name))")
      .eq("workspace_id", workspaceId)
      .eq("pipelines.workspace_id", workspaceId);
    if (factoryId) query = query.eq("pipelines.factory_id", factoryId);
    const { data, error } = await query.order("id").range(start, start + 249);
    if (error) throw error;
    for (const stage of data) {
      options.push({
        id: stage.id,
        label: [
          stage.name + (stage.archived_at ? " (archived)" : ""),
          stage.pipelines.name,
          ...(factoryId ? [] : [stage.pipelines.factories.name]),
        ].join(" · "),
      });
    }
    if (data.length < 250) break;
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

export async function loadRunPromptFilterLabel(
  { supabase, workspaceId, factoryId }: Scope,
  { agentId, agentPromptRevisionId }: RunCatalogQuery,
) {
  if (!agentId || !agentPromptRevisionId) return null;
  let query = supabase
    .from("factory_agent_prompt_revisions")
    .select("revision_number, factory_agents!inner(name)")
    .eq("workspace_id", workspaceId)
    .eq("agent_id", agentId)
    .eq("id", agentPromptRevisionId);
  if (factoryId) query = query.eq("factory_id", factoryId);
  const { data } = await query.maybeSingle();
  return data ? `${data.factory_agents.name} · Prompt revision ${data.revision_number}` : null;
}
