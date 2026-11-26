import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { Database, Tables } from "@/lib/supabase/database.types";

import type { createFactoryAgentSchema, saveFactoryAgentPromptSchema } from "./contracts";

type Client = SupabaseClient<Database>;
type AgentScope = { workspaceId: string; factoryId: string };
type ActorScope = AgentScope & { actorUserId: string };

export type FactoryAgent = Pick<
  Tables<"factory_agents">,
  "id" | "name" | "slug" | "is_default" | "authority" | "created_at"
>;
export type FactoryAgentPromptRevision = Pick<
  Tables<"factory_agent_prompt_revisions">,
  "id" | "agent_id" | "revision_number" | "prompt_md" | "prompt_sha256" | "created_at"
>;

export async function listFactoryAgents(
  client: Client,
  input: AgentScope & { afterId?: string; limit: number },
) {
  let query = client
    .from("factory_agents")
    .select("id, name, slug, is_default, authority, created_at")
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .order("id")
    .limit(input.limit + 1);
  if (input.afterId) query = query.gt("id", input.afterId);
  const { data, error } = await query;
  if (error) throw error;
  const agents = data.slice(0, input.limit);
  return {
    agents,
    nextAfterId: data.length > input.limit ? (agents.at(-1)?.id ?? null) : null,
  };
}

function quoteAgentFilter(value: string) {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export async function searchFactoryAgentDirectory(
  client: Client,
  {
    workspaceId,
    factoryId,
    search,
    afterId,
    limit,
  }: AgentScope & {
    search?: string;
    afterId?: string;
    limit: number;
  },
) {
  const scopedAgents = () => client.from("factory_agents");
  const cursor = afterId
    ? await scopedAgents()
        .select("name")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("id", afterId)
        .maybeSingle()
    : null;
  if (cursor?.error) throw cursor.error;
  if (afterId && !cursor?.data) return { agents: [], nextAfterId: null };

  let query = scopedAgents()
    .select("id, name, slug, is_default")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("name")
    .order("id")
    .limit(limit + 1);
  if (search) {
    const literal = quoteAgentFilter(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    query = query.or(`name.imatch.${literal},slug.imatch.${literal}`);
  }
  if (cursor?.data) {
    const name = quoteAgentFilter(cursor.data.name);
    query = query.or(`name.gt.${name},and(name.eq.${name},id.gt.${afterId})`);
  }
  const { data, error } = await query;
  if (error) throw error;
  const agents = data.slice(0, limit);
  return { agents, nextAfterId: data.length > limit ? (agents.at(-1)?.id ?? null) : null };
}

export async function listFactoryAgentPromptRevisions(
  client: Client,
  input: AgentScope & { agentId: string; beforeRevisionNumber?: number; limit: number },
) {
  let query = client
    .from("factory_agent_prompt_revisions")
    .select("id, agent_id, revision_number, prompt_md, prompt_sha256, created_at")
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .eq("agent_id", input.agentId)
    .order("revision_number", { ascending: false })
    .limit(input.limit + 1);
  if (input.beforeRevisionNumber !== undefined)
    query = query.lt("revision_number", input.beforeRevisionNumber);
  const { data, error } = await query;
  if (error) throw error;
  const revisions = data.slice(0, input.limit);
  return {
    revisions,
    nextBeforeRevisionNumber:
      data.length > input.limit ? (revisions.at(-1)?.revision_number ?? null) : null,
  };
}

export async function createFactoryAgent(
  client: Client,
  input: ActorScope & z.output<typeof createFactoryAgentSchema>,
) {
  const { data, error } = await client
    .rpc("create_factory_agent", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_name: input.name,
      p_slug: input.slug,
      p_prompt_md: input.promptMd,
    })
    .single();
  if (error || !data) throw error ?? new Error("Agent creation returned no prompt revision.");
  return data;
}

export async function saveFactoryAgentPromptRevision(
  client: Client,
  input: ActorScope & { agentId: string } & z.output<typeof saveFactoryAgentPromptSchema>,
) {
  const { data, error } = await client
    .rpc("save_factory_agent_prompt_revision", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_agent_id: input.agentId,
      p_expected_revision_number: input.expectedRevisionNumber,
      p_prompt_md: input.promptMd,
    })
    .single();
  if (error || !data) throw error ?? new Error("Agent edit returned no prompt revision.");
  return data;
}
