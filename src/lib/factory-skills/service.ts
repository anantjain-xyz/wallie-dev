import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { Database, Tables } from "@/lib/supabase/database.types";

import type {
  createFactorySkillSchema,
  FactorySkillSource,
  saveFactorySkillRevisionSchema,
} from "./contracts";

type Client = SupabaseClient<Database>;
type FactoryScope = { workspaceId: string; factoryId: string };
type ActorScope = FactoryScope & { actorUserId: string };
type SkillRevision = Tables<"factory_skill_revisions">;

export async function listFactorySkills(
  client: Client,
  input: FactoryScope & { afterId?: string; limit: number },
) {
  let query = client
    .from("factory_skills")
    .select("id, name, slug, created_at")
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .order("id")
    .limit(input.limit + 1);
  if (input.afterId) query = query.gt("id", input.afterId);
  const { data, error } = await query;
  if (error) throw error;
  const skills = data.slice(0, input.limit);
  return {
    skills,
    nextAfterId: data.length > input.limit ? (skills.at(-1)?.id ?? null) : null,
  };
}

export async function listFactorySkillRevisions(
  client: Client,
  input: FactoryScope & { skillId: string; beforeRevisionNumber?: number; limit: number },
) {
  let query = client
    .from("factory_skill_revisions")
    .select(
      "id, skill_id, revision_number, content_md, content_sha256, source_kind, source_ref, revoked_at, created_at",
    )
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .eq("skill_id", input.skillId)
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

async function skillSourceParameters(
  client: Client,
  input: FactoryScope & { source: FactorySkillSource },
) {
  const { source } = input;
  if (source.kind === "manual") return { p_source_kind: "manual" };

  const { data, error } = await client
    .from("github_repositories")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .eq("id", source.repositoryId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw Object.assign(new Error("The source repository is unavailable in this factory."), {
      code: "P0002",
    });
  }

  return {
    p_source_kind: "repository",
    p_source_ref: `${source.repositoryId}@${source.commitSha}:${source.path}`,
  };
}

export async function createFactorySkill(
  client: Client,
  input: ActorScope & z.output<typeof createFactorySkillSchema>,
) {
  const source = await skillSourceParameters(client, input);
  const { data, error } = await client
    .rpc("create_factory_skill", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_name: input.name,
      p_slug: input.slug,
      p_content_md: input.contentMd,
      ...source,
    })
    .single<SkillRevision>();
  if (error || !data) throw error ?? new Error("Skill creation returned no revision.");
  return data;
}

export async function saveFactorySkillRevision(
  client: Client,
  input: ActorScope & { skillId: string } & z.output<typeof saveFactorySkillRevisionSchema>,
) {
  const source = await skillSourceParameters(client, input);
  const { data, error } = await client
    .rpc("save_factory_skill_revision", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_skill_id: input.skillId,
      p_expected_revision_number: input.expectedRevisionNumber,
      p_content_md: input.contentMd,
      ...source,
    })
    .single<SkillRevision>();
  if (error || !data) throw error ?? new Error("Skill edit returned no revision.");
  return data;
}

export async function revokeFactorySkillRevision(
  client: Client,
  input: ActorScope & { skillId: string; revisionId: string },
) {
  const { data, error } = await client
    .rpc("revoke_factory_skill_revision", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_skill_id: input.skillId,
      p_revision_id: input.revisionId,
    })
    .single<SkillRevision>();
  if (error || !data) throw error ?? new Error("Skill revocation returned no revision.");
  return data;
}
