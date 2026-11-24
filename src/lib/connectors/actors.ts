import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import type { Database } from "@/lib/supabase/database.types";

type Client = Pick<SupabaseClient<Database>, "rpc">;

const uuid = z.uuid().toLowerCase();
const revision = z.number().int().positive();
const providerIdentity = {
  provider: z.enum(["github", "linear"]),
  externalTenantId: z
    .string()
    .min(1)
    .max(192)
    .regex(/^[^\s\p{Cc}]+$/u),
  externalActorId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\s\p{Cc}]+$/u),
};
const humanActor = z.strictObject({ ...providerIdentity, kind: z.literal("human") });
const serviceActor = z.strictObject({ ...providerIdentity, kind: z.literal("service") });
const externalActor = z.discriminatedUnion("kind", [humanActor, serviceActor]);
const installationScope = {
  workspaceId: uuid,
  factoryId: uuid,
  installationGeneration: revision,
};

const eventAuthorityInput = z.strictObject({
  ...installationScope,
  resourceId: uuid,
  mappingRevision: revision,
  actor: externalActor,
  executionGrantId: uuid,
  executionGrantVersion: revision,
});

const authorityFields = z.object({
  actor_link_id: uuid,
  execution_grant_id: uuid,
  execution_grant_version: revision,
  service_principal_id: uuid,
  budget_payer_member_id: uuid,
});
const eventAuthorityResult = z
  .array(
    z.discriminatedUnion("actor_kind", [
      authorityFields.extend({
        actor_kind: z.literal("human"),
        initiating_member_id: uuid,
        initiating_service_principal_id: z.null(),
      }),
      authorityFields
        .extend({
          actor_kind: z.literal("service"),
          initiating_member_id: z.null(),
          initiating_service_principal_id: uuid,
        })
        .refine(
          (authority) =>
            authority.initiating_service_principal_id === authority.service_principal_id,
        ),
    ]),
  )
  .max(1);

const actorLinkInput = z.strictObject({
  ...installationScope,
  installationId: uuid,
  actorUserId: uuid,
  actor: z.discriminatedUnion("kind", [
    humanActor,
    serviceActor.extend({ servicePrincipalId: uuid }),
  ]),
});
const revokeActorLinkInput = z.strictObject({ workspaceId: uuid, actorUserId: uuid, linkId: uuid });

function actorParameters(actor: z.output<typeof externalActor>) {
  return {
    p_provider: actor.provider,
    p_external_tenant_id: actor.externalTenantId,
    p_external_actor_id: actor.externalActorId,
    p_actor_kind: actor.kind,
  };
}

/** The provider adapter verifies the event. The grant pin comes from local configuration. */
export async function resolveConnectorEventAuthority(
  admin: Client,
  input: z.input<typeof eventAuthorityInput>,
) {
  const event = eventAuthorityInput.parse(input);
  const { data, error } = await admin.rpc("resolve_connector_event_authority", {
    p_workspace_id: event.workspaceId,
    p_factory_id: event.factoryId,
    p_resource_id: event.resourceId,
    p_installation_generation: event.installationGeneration,
    p_mapping_revision: event.mappingRevision,
    ...actorParameters(event.actor),
    p_execution_grant_id: event.executionGrantId,
    p_execution_grant_version: event.executionGrantVersion,
  });
  if (error) throw error;
  const [authority] = eventAuthorityResult.parse(data);
  if (!authority) return null;
  if (
    authority.actor_kind !== event.actor.kind ||
    authority.execution_grant_id !== event.executionGrantId ||
    authority.execution_grant_version !== event.executionGrantVersion
  ) {
    throw new Error("Connector authority does not match the verified actor and grant.");
  }
  return authority;
}

/** The caller verifies the external actor and authenticates the Wallie operator. */
export async function linkConnectorActor(admin: Client, input: z.input<typeof actorLinkInput>) {
  const link = actorLinkInput.parse(input);
  const { data, error } = await admin.rpc("link_connector_actor", {
    p_workspace_id: link.workspaceId,
    p_factory_id: link.factoryId,
    p_actor_user_id: link.actorUserId,
    p_installation_id: link.installationId,
    p_installation_generation: link.installationGeneration,
    ...actorParameters(link.actor),
    ...(link.actor.kind === "service"
      ? { p_service_principal_id: link.actor.servicePrincipalId }
      : {}),
  });
  if (error) throw error;
  return uuid.parse(data);
}

export async function revokeConnectorActorLink(
  admin: Client,
  input: z.input<typeof revokeActorLinkInput>,
) {
  const link = revokeActorLinkInput.parse(input);
  const { data, error } = await admin.rpc("revoke_connector_actor_link", {
    p_workspace_id: link.workspaceId,
    p_actor_user_id: link.actorUserId,
    p_link_id: link.linkId,
  });
  if (error) throw error;
  return z.boolean().parse(data);
}
