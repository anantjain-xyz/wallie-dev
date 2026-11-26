import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { Database, Json } from "@/lib/supabase/database.types";

import {
  type createFactoryScorerSchema,
  type saveFactoryScorerRevisionSchema,
  scorerRevisionSchema,
} from "./authoring-contracts";
import { factoryScorerDefinitionSchema, type FactoryScorerDefinition } from "./contracts";

type Client = SupabaseClient<Database>;
type FactoryScope = { workspaceId: string; factoryId: string };
type ActorScope = FactoryScope & { actorUserId: string };
type ScorerScope = FactoryScope & { scorerId: string };

const scorerColumns = "id, name, slug, created_at";
const revisionHistoryColumns = "id, scorer_id, revision_number, created_at";

export async function listFactoryScorers(
  client: Client,
  input: FactoryScope & { afterId?: string; limit: number },
) {
  let query = client
    .from("factory_scorers")
    .select(scorerColumns)
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .order("id")
    .limit(input.limit + 1);
  if (input.afterId) query = query.gt("id", input.afterId);
  const { data, error } = await query;
  if (error) throw error;
  const scorers = data.slice(0, input.limit);
  return {
    scorers,
    nextAfterId: data.length > input.limit ? (scorers.at(-1)?.id ?? null) : null,
  };
}

export async function readFactoryScorer(client: Client, input: ScorerScope) {
  const { data, error } = await client
    .from("factory_scorers")
    .select(scorerColumns)
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .eq("id", input.scorerId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function filterLiteral(value: string) {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export async function searchFactoryScorers(
  client: Client,
  input: FactoryScope & { afterId?: string; search: string; limit: number },
) {
  const cursor = input.afterId
    ? await readFactoryScorer(client, { ...input, scorerId: input.afterId })
    : null;
  if (input.afterId && !cursor) return { scorers: [], nextAfterId: null };

  let query = client
    .from("factory_scorers")
    .select(`${scorerColumns}, factory_scorer_revisions(definition)`)
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .order("name")
    .order("id")
    .order("revision_number", { ascending: false, referencedTable: "factory_scorer_revisions" })
    .limit(1, { referencedTable: "factory_scorer_revisions" })
    .limit(input.limit + 1);
  if (input.search) {
    const match = filterLiteral(input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    query = query.or(`name.imatch.${match},slug.imatch.${match}`);
  }
  if (cursor) {
    const name = filterLiteral(cursor.name);
    query = query.or(`name.gt.${name},and(name.eq.${name},id.gt.${cursor.id})`);
  }
  const { data, error } = await query;
  if (error) throw error;
  const scorers = data.slice(0, input.limit).map(({ factory_scorer_revisions, ...scorer }) => {
    const rubric = factoryScorerDefinitionSchema.safeParse(factory_scorer_revisions[0]?.definition);
    return {
      ...scorer,
      requirements: rubric.success
        ? { evidence: rubric.data.requiredEvidence, scale: rubric.data.scoring.kind }
        : null,
    };
  });
  return {
    scorers,
    nextAfterId: data.length > input.limit ? (scorers.at(-1)?.id ?? null) : null,
  };
}

export async function listFactoryScorerRevisions(
  client: Client,
  input: ScorerScope & { beforeRevisionNumber?: number; limit: number },
) {
  let query = client
    .from("factory_scorer_revisions")
    .select(revisionHistoryColumns)
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .eq("scorer_id", input.scorerId)
    .order("revision_number", { ascending: false })
    .limit(input.limit + 1);
  if (input.beforeRevisionNumber !== undefined) {
    query = query.lt("revision_number", input.beforeRevisionNumber);
  }
  const { data, error } = await query;
  if (error) throw error;
  const revisions = data.slice(0, input.limit);
  return {
    revisions,
    nextBeforeRevisionNumber:
      data.length > input.limit ? (revisions.at(-1)?.revision_number ?? null) : null,
  };
}

export async function readFactoryScorerRevision(
  client: Client,
  input: ScorerScope & { revisionId: string },
) {
  const { data, error } = await client
    .from("factory_scorer_revisions")
    .select(`${revisionHistoryColumns}, definition`)
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .eq("scorer_id", input.scorerId)
    .eq("id", input.revisionId)
    .maybeSingle();
  if (error) throw error;
  return data ? scorerRevisionSchema.parse(data) : null;
}

function definitionJson(definition: FactoryScorerDefinition): Json {
  return { ...definition, requiredEvidence: [...definition.requiredEvidence] };
}

export async function createFactoryScorer(
  client: Client,
  input: ActorScope & z.output<typeof createFactoryScorerSchema>,
) {
  const base =
    input.name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "scorer";
  for (let attempt = 0; ; attempt++) {
    const slug =
      input.slug ??
      (attempt === 0
        ? base
        : `${base.slice(0, 47).replace(/-+$/, "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`);
    const { data, error } = await client
      .rpc("create_factory_scorer", {
        p_workspace_id: input.workspaceId,
        p_factory_id: input.factoryId,
        p_actor_user_id: input.actorUserId,
        p_name: input.name,
        p_slug: slug,
        p_definition: definitionJson(input.definition),
      })
      .single();
    if (!error) return scorerRevisionSchema.parse(data);
    if (input.slug || error.code !== "23505" || attempt >= 2) throw error;
  }
}

export async function saveFactoryScorerRevision(
  client: Client,
  input: ActorScope & ScorerScope & z.output<typeof saveFactoryScorerRevisionSchema>,
) {
  const { data, error } = await client
    .rpc("save_factory_scorer_revision", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_scorer_id: input.scorerId,
      p_expected_revision: input.expectedRevisionNumber,
      p_definition: definitionJson(input.definition),
    })
    .single();
  if (error) throw error;
  return scorerRevisionSchema.parse(data);
}
