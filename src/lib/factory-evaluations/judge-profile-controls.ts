import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database, Tables } from "@/lib/supabase/database.types";

import { factoryJudgeProfileSchema } from "./judge-contracts";
import { factoryJudgeProfileRowSchema } from "./judge-inputs";

const revision = z.number().int().min(0).max(2_147_483_647);
export const editFactoryJudgeProfileSchema = z.strictObject({
  expectedRevision: revision,
  modelId: factoryJudgeProfileSchema.shape.model,
  providerRoute: factoryJudgeProfileSchema.shape.provider,
  allowImages: factoryJudgeProfileSchema.shape.allowImage,
  allowVideo: factoryJudgeProfileSchema.shape.allowVideo,
  apiKey: z
    .string()
    .min(12)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
});
export const revokeFactoryJudgeProfileSchema = z.strictObject({ expectedRevision: revision });

type Client = Pick<SupabaseClient<Database>, "rpc">;
type Actor = { workspaceId: string; actorUserId: string };
type ProfileRow = Tables<"factory_judge_profile_revisions">;
const profileProjection =
  "id,workspace_id,revision,enabled,provider,model_id,provider_route,allow_images,allow_video,created_at";

function encodeProfile(workspaceId: string, row: unknown) {
  const profile = factoryJudgeProfileRowSchema.parse(row);
  if (profile.workspace_id !== workspaceId.toLowerCase()) {
    throw new Error("The judge profile returned an invalid workspace.");
  }
  return {
    id: profile.id,
    revision: profile.revision,
    enabled: profile.enabled,
    provider: profile.provider,
    modelId: profile.model_id,
    providerRoute: profile.provider_route,
    allowImages: profile.allow_images,
    allowVideo: profile.allow_video,
    createdAt: profile.created_at,
  };
}

export async function readFactoryJudgeProfile(client: Client, actor: Actor) {
  const { data, error } = await client
    .rpc("get_factory_judge_profile", {
      p_workspace_id: actor.workspaceId,
      p_actor_user_id: actor.actorUserId,
    })
    .select(profileProjection)
    .maybeSingle<ProfileRow>();
  if (error) throw error;
  return data?.id ? encodeProfile(actor.workspaceId, data) : null;
}

export async function saveFactoryJudgeProfile(
  client: Client,
  actor: Actor,
  input: z.output<typeof editFactoryJudgeProfileSchema>,
) {
  const { data, error } = await client
    .rpc("configure_factory_judge_profile", {
      p_workspace_id: actor.workspaceId,
      p_actor_user_id: actor.actorUserId,
      p_expected_revision: input.expectedRevision,
      p_model_id: input.modelId,
      p_provider_route: input.providerRoute,
      p_allow_images: input.allowImages,
      p_allow_video: input.allowVideo,
      ...(input.apiKey ? { p_encrypted_api_key: encryptSecretValue(input.apiKey) } : {}),
    })
    .select(profileProjection)
    .single<ProfileRow>();
  if (error) throw error;
  return encodeProfile(actor.workspaceId, data);
}

export async function revokeFactoryJudgeProfile(
  client: Client,
  actor: Actor,
  expectedRevision: number,
) {
  const { data, error } = await client
    .rpc("revoke_factory_judge_profile", {
      p_workspace_id: actor.workspaceId,
      p_actor_user_id: actor.actorUserId,
      p_expected_revision: expectedRevision,
    })
    .select(profileProjection)
    .single<ProfileRow>();
  if (error) throw error;
  return encodeProfile(actor.workspaceId, data);
}
