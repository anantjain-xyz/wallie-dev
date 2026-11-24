import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

type VerifiedConnectorInstallation = {
  externalInstallationId: string;
  externalTenantId: string;
} & (
  | { provider: "github"; credential?: never }
  | { provider: "linear"; secretId: string; materialRevision: number; credential?: never }
  | { provider: "slack"; credential: string }
);

const configuredInstallation = z.tuple([
  z.object({ installation_id: z.uuid(), generation: z.number().int().positive() }),
]);

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
    ...(installation.provider === "slack"
      ? { p_encrypted_credential: encryptSecretValue(installation.credential) }
      : {}),
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
