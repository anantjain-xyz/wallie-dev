import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  linkConnectorActor,
  resolveConnectorEventAuthority,
  revokeConnectorActorLink,
} from "./actors";

const scope = {
  workspaceId: "e9af51b6-77e3-4fd9-82ef-4310d27fdd84",
  factoryId: "5a50927d-3124-4daf-a337-2ced19866412",
  installationGeneration: 4,
};
const externalActor = {
  provider: "github",
  externalTenantId: "1001",
  externalActorId: "2002",
} as const;
const event = {
  ...scope,
  resourceId: "1ccbb94e-b772-4147-af2a-317882e2a722",
  mappingRevision: 2,
  actor: { ...externalActor, kind: "human" as const },
  executionGrantId: "8dcea287-86ad-4ea9-80c0-de100b746998",
  executionGrantVersion: 3,
};
const actorUserId = "2897bd8a-918e-46b9-af5f-4cf8bc7f089f";
const authority = {
  actor_link_id: "4b4c5fb5-d98b-456c-ae9a-a80e9bcbe670",
  actor_kind: "human",
  initiating_member_id: "ce3aa096-d372-4a35-a886-17338d660d38",
  initiating_service_principal_id: null,
  execution_grant_id: event.executionGrantId,
  execution_grant_version: event.executionGrantVersion,
  service_principal_id: "b44ff391-186c-489e-9c4c-70d700a9231f",
  budget_payer_member_id: "bb036ad4-cd8b-4eb1-a1d0-e8abbd09c72a",
};

function clientWithResponse(data: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data));
  const client = createClient<Database>("https://database.example.test", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  return { client, fetch };
}

describe("resolveConnectorEventAuthority", () => {
  it("resolves a human actor under the exact provider scope and local grant", async () => {
    const { client, fetch } = clientWithResponse([authority]);

    await expect(resolveConnectorEventAuthority(client, event)).resolves.toEqual(authority);

    const request = new Request(...fetch.mock.calls[0]!);
    expect(new URL(request.url).pathname).toBe("/rest/v1/rpc/resolve_connector_event_authority");
    expect(await request.json()).toEqual({
      p_workspace_id: event.workspaceId,
      p_factory_id: event.factoryId,
      p_resource_id: event.resourceId,
      p_installation_generation: event.installationGeneration,
      p_mapping_revision: event.mappingRevision,
      p_provider: event.actor.provider,
      p_external_tenant_id: event.actor.externalTenantId,
      p_external_actor_id: event.actor.externalActorId,
      p_actor_kind: "human",
      p_execution_grant_id: event.executionGrantId,
      p_execution_grant_version: event.executionGrantVersion,
    });
  });

  it("preserves service attribution separately from the human payer", async () => {
    const serviceAuthority = {
      ...authority,
      actor_kind: "service",
      initiating_member_id: null,
      initiating_service_principal_id: authority.service_principal_id,
    };
    const { client, fetch } = clientWithResponse([serviceAuthority]);

    await expect(
      resolveConnectorEventAuthority(client, {
        ...event,
        actor: { ...externalActor, kind: "service" },
      }),
    ).resolves.toEqual(serviceAuthority);

    const request = new Request(...fetch.mock.calls[0]!);
    expect(await request.json()).toMatchObject({ p_actor_kind: "service" });
  });

  it("rejects an event with a caller-supplied Wallie member", async () => {
    const { client, fetch } = clientWithResponse([authority]);
    const forgedEvent = {
      ...event,
      actor: { ...event.actor, memberId: authority.initiating_member_id },
    };

    await expect(resolveConnectorEventAuthority(client, forgedEvent)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null for an empty authority result", async () => {
    const { client } = clientWithResponse([]);
    await expect(resolveConnectorEventAuthority(client, event)).resolves.toBeNull();
  });

  it("rejects an unexpected authority grant", async () => {
    const stale = clientWithResponse([{ ...authority, execution_grant_version: 2 }]);
    await expect(resolveConnectorEventAuthority(stale.client, event)).rejects.toThrow(
      "Connector authority does not match the verified actor and grant.",
    );
  });

  it("rejects service authority issued for a different principal", async () => {
    const { client } = clientWithResponse([
      {
        ...authority,
        actor_kind: "service",
        initiating_member_id: null,
        initiating_service_principal_id: "ee204460-1053-4461-af47-2f35bc16d934",
      },
    ]);

    await expect(
      resolveConnectorEventAuthority(client, {
        ...event,
        actor: { ...externalActor, kind: "service" },
      }),
    ).rejects.toThrow();
  });
});

describe("connector actor links", () => {
  it("links an exact external service actor to the selected factory principal", async () => {
    const { client, fetch } = clientWithResponse(authority.actor_link_id);
    const installationId = "ee204460-1053-4461-af47-2f35bc16d934";
    await expect(
      linkConnectorActor(client, {
        ...scope,
        actorUserId,
        installationId,
        actor: {
          ...externalActor,
          kind: "service",
          servicePrincipalId: authority.service_principal_id,
        },
      }),
    ).resolves.toBe(authority.actor_link_id);

    const request = new Request(...fetch.mock.calls[0]!);
    expect(new URL(request.url).pathname).toBe("/rest/v1/rpc/link_connector_actor");
    expect(await request.json()).toEqual({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: actorUserId,
      p_installation_id: installationId,
      p_installation_generation: scope.installationGeneration,
      p_provider: externalActor.provider,
      p_external_tenant_id: externalActor.externalTenantId,
      p_external_actor_id: externalActor.externalActorId,
      p_actor_kind: "service",
      p_service_principal_id: authority.service_principal_id,
    });
  });

  it("revokes only the selected link within the authenticated workspace", async () => {
    const { client, fetch } = clientWithResponse(true);

    await expect(
      revokeConnectorActorLink(client, {
        workspaceId: scope.workspaceId,
        actorUserId,
        linkId: authority.actor_link_id,
      }),
    ).resolves.toBe(true);

    const request = new Request(...fetch.mock.calls[0]!);
    expect(new URL(request.url).pathname).toBe("/rest/v1/rpc/revoke_connector_actor_link");
    expect(await request.json()).toEqual({
      p_workspace_id: scope.workspaceId,
      p_actor_user_id: actorUserId,
      p_link_id: authority.actor_link_id,
    });
  });
});
