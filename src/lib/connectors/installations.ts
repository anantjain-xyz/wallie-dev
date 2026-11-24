import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import type { Database } from "@/lib/supabase/database.types";

type VerifiedConnectorInstallation = {
  externalInstallationId: string;
  externalTenantId: string;
} & (
  | { provider: "github"; secretId?: never; materialRevision?: never }
  | { provider: "linear"; secretId: string; materialRevision: number }
);

const configuredInstallation = z.tuple([
  z.object({ installation_id: z.uuid(), generation: z.number().int().positive() }),
]);

const subscriptionFields = z.object({
  installation_id: z.uuid(),
  installation_generation: z.number().int().positive(),
  mapping_revision: z.number().int().positive(),
  cursor_generation: z.number().int().nonnegative(),
  cursor_position: z.string().nullable(),
  credential_ref: z.uuid(),
});

const subscriptionResult = z
  .array(
    z.discriminatedUnion("credential_kind", [
      subscriptionFields.extend({
        credential_kind: z.literal("github_installation"),
        credential_material_revision: z.null(),
      }),
      subscriptionFields.extend({
        credential_kind: z.literal("slack_bot"),
        credential_material_revision: z.null(),
      }),
      subscriptionFields.extend({
        credential_kind: z.literal("workspace_secret"),
        credential_material_revision: z.number().int().positive(),
      }),
    ]),
  )
  .max(1);

export async function configureConnectorInstallation(
  admin: SupabaseClient<Database>,
  input: {
    workspaceId: string;
    factoryId: string;
    actorUserId: string;
    expectedGeneration: number;
    installation: VerifiedConnectorInstallation;
  },
) {
  const { installation } = input;
  const { data, error } = await admin.rpc("configure_connector_installation", {
    p_workspace_id: input.workspaceId,
    p_factory_id: input.factoryId,
    p_actor_user_id: input.actorUserId,
    p_provider: installation.provider,
    p_external_tenant_id: installation.externalTenantId,
    p_external_installation_id: installation.externalInstallationId,
    p_expected_generation: input.expectedGeneration,
    ...(installation.provider === "linear"
      ? {
          p_linear_secret_id: installation.secretId,
          p_linear_material_revision: installation.materialRevision,
        }
      : {}),
  });
  if (error) throw error;
  const [receipt] = configuredInstallation.parse(data);
  return { installationId: receipt.installation_id, generation: receipt.generation };
}

export async function readConnectorSubscription(
  admin: SupabaseClient<Database>,
  input: { workspaceId: string; factoryId: string; resourceId: string; stream?: string },
) {
  const { data, error } = await admin.rpc("read_connector_subscription", {
    p_workspace_id: input.workspaceId,
    p_factory_id: input.factoryId,
    p_resource_id: input.resourceId,
    ...(input.stream === undefined ? {} : { p_stream: input.stream }),
  });
  if (error) throw error;
  const [subscription] = subscriptionResult.parse(data);
  return subscription ?? null;
}
