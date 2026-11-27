import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { FACTORY_NAME_MAX_LENGTH, factoryNameSchema } from "@/lib/factories/contracts";
import type { Database, Tables } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

export const factoryRoleSchema = z.enum(["manager", "member"]);
export const factoryArchiveReasonSchema = z.string().trim().max(500).nullable().optional();

export const factoryManagementCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("archive"), reason: factoryArchiveReasonSchema }).strict(),
  z.object({ action: z.literal("restore") }).strict(),
  z
    .object({
      action: z.literal("rename"),
      expectedName: z.string().min(1).max(FACTORY_NAME_MAX_LENGTH),
      name: factoryNameSchema,
    })
    .strict(),
]);
export type FactoryManagementCommand = z.infer<typeof factoryManagementCommandSchema>;
export const grantFactoryMembershipSchema = z
  .object({ memberId: z.string().uuid(), role: factoryRoleSchema.default("member") })
  .strict();
export const revokeFactoryMembershipSchema = z
  .object({
    memberId: z.string().uuid(),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type FactoryScopeEntry = {
  factoryId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  status: "active" | "archived";
  role: "manager" | "member";
  sessionCount: number;
  pipelineCount: number;
  repositoryCount: number;
  memberCount: number;
};

export type FactoryRecord = Pick<
  Tables<"factories">,
  | "archived_at"
  | "archived_reason"
  | "created_at"
  | "id"
  | "is_default"
  | "name"
  | "slug"
  | "status"
>;

export function mapFactoryRecord(row: Tables<"factories">): FactoryRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    is_default: row.is_default,
    status: row.status,
    archived_at: row.archived_at,
    archived_reason: row.archived_reason,
    created_at: row.created_at,
  };
}

export function mapFactoryScope(
  rows: Database["public"]["Functions"]["read_factory_scope"]["Returns"],
): FactoryScopeEntry[] {
  return rows.map((row) => ({
    factoryId: row.factory_id,
    name: row.name,
    slug: row.slug,
    isDefault: row.is_default,
    status: row.status === "archived" ? "archived" : "active",
    role: row.role === "manager" ? "manager" : "member",
    sessionCount: Number(row.session_count),
    pipelineCount: Number(row.pipeline_count),
    repositoryCount: Number(row.repository_count),
    memberCount: Number(row.member_count),
  }));
}

export async function listFactoryScope(
  admin: Client,
  workspaceId: string,
  actorUserId: string,
): Promise<FactoryScopeEntry[]> {
  const { data, error } = await admin.rpc("read_factory_scope", {
    p_workspace_id: workspaceId,
    p_actor_user_id: actorUserId,
  });
  if (error) throw error;
  return mapFactoryScope(data ?? []);
}

export async function createFactory(
  admin: Client,
  input: { workspaceId: string; actorUserId: string; name: string; slug: string },
): Promise<FactoryRecord> {
  const { data, error } = await admin
    .rpc("create_factory", {
      p_workspace_id: input.workspaceId,
      p_actor_user_id: input.actorUserId,
      p_name: input.name,
      p_slug: input.slug,
    })
    .single();
  if (error || !data) throw error ?? new Error("Factory creation returned no record.");
  return mapFactoryRecord(data);
}

export async function archiveAdditionalFactory(
  admin: Client,
  input: {
    workspaceId: string;
    factoryId: string;
    actorUserId: string;
    reason?: string | null;
  },
): Promise<FactoryRecord> {
  const { data, error } = await admin
    .rpc("archive_additional_factory", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_reason: input.reason ?? undefined,
    })
    .single();
  if (error || !data) throw error ?? new Error("Factory archive returned no record.");
  return mapFactoryRecord(data);
}

export async function renameFactory(
  admin: Client,
  input: {
    workspaceId: string;
    factoryId: string;
    actorUserId: string;
    expectedName: string;
    name: string;
  },
): Promise<FactoryRecord> {
  const { data, error } = await admin
    .rpc("rename_factory", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_expected_name: input.expectedName,
      p_name: input.name,
    })
    .single();
  if (error || !data) throw error ?? new Error("Factory rename returned no record.");
  return mapFactoryRecord(data);
}

export async function restoreFactory(
  admin: Client,
  input: { workspaceId: string; factoryId: string; actorUserId: string },
): Promise<FactoryRecord> {
  const { data, error } = await admin
    .rpc("restore_factory", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
    })
    .single();
  if (error || !data) throw error ?? new Error("Factory restore returned no record.");
  return mapFactoryRecord(data);
}

export async function grantFactoryMembership(
  admin: Client,
  input: {
    workspaceId: string;
    factoryId: string;
    actorUserId: string;
    memberId: string;
    role: "manager" | "member";
  },
): Promise<Tables<"factory_members">> {
  const { data, error } = await admin
    .rpc("grant_factory_membership", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_member_id: input.memberId,
      p_role: input.role,
    })
    .single();
  if (error || !data) throw error ?? new Error("Factory membership grant returned no record.");
  return data;
}

export async function revokeFactoryMembership(
  admin: Client,
  input: {
    workspaceId: string;
    factoryId: string;
    actorUserId: string;
    memberId: string;
    reason?: string | null;
  },
): Promise<Tables<"factory_members">> {
  const { data, error } = await admin
    .rpc("revoke_factory_membership", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_member_id: input.memberId,
      p_reason: input.reason ?? undefined,
    })
    .single();
  if (error || !data) throw error ?? new Error("Factory membership revocation returned no record.");
  return data;
}

export function factoryErrorStatus(code: string | undefined) {
  switch (code) {
    case "42501":
      return 403;
    case "P0002":
      return 404;
    case "23505":
    case "P0011":
    case "PT409":
      return 409;
    case "22023":
    case "23514":
    case "PT422":
      return 422;
    default:
      return 500;
  }
}
