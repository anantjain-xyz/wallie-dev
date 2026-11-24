import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { configureConnectorInstallation, readConnectorSubscription } from "./installations";

const scope = {
  workspaceId: "e9af51b6-77e3-4fd9-82ef-4310d27fdd84",
  factoryId: "5a50927d-3124-4daf-a337-2ced19866412",
  actorUserId: "2897bd8a-918e-46b9-af5f-4cf8bc7f089f",
  expectedGeneration: 0,
};
const installationId = "4b4c5fb5-d98b-456c-ae9a-a80e9bcbe670";

function clientWithResponse(data: unknown = [{ installation_id: installationId, generation: 1 }]) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data));
  const client = createClient<Database>("https://database.example.test", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  return { client, fetch };
}

describe("configureConnectorInstallation", () => {
  it("lets the database resolve the existing GitHub installation", async () => {
    const { client, fetch } = clientWithResponse();

    await expect(
      configureConnectorInstallation(client, {
        ...scope,
        installation: {
          provider: "github",
          externalTenantId: "fixture-github-tenant",
          externalInstallationId: "123",
        },
      }),
    ).resolves.toEqual({ installationId, generation: 1 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = new Request(...fetch.mock.calls[0]!);
    expect(new URL(request.url).pathname).toBe("/rest/v1/rpc/configure_connector_installation");
    expect(await request.json()).toEqual({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: scope.actorUserId,
      p_expected_generation: scope.expectedGeneration,
      p_provider: "github",
      p_external_tenant_id: "fixture-github-tenant",
      p_external_installation_id: "123",
    });
  });

  it("sends the exact verified Linear secret reference and material revision", async () => {
    const { client, fetch } = clientWithResponse();
    const secretId = "8dcea287-86ad-4ea9-80c0-de100b746998";

    await configureConnectorInstallation(client, {
      ...scope,
      installation: {
        provider: "linear",
        externalTenantId: "fixture-linear-tenant",
        externalInstallationId: "fixture-linear-installation",
        secretId,
        materialRevision: 4,
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = new Request(...fetch.mock.calls[0]!);
    expect(await request.json()).toMatchObject({
      p_provider: "linear",
      p_linear_secret_id: secretId,
      p_linear_material_revision: 4,
    });
  });
});

describe("readConnectorSubscription", () => {
  const resource = {
    workspaceId: scope.workspaceId,
    factoryId: scope.factoryId,
    resourceId: "1ccbb94e-b772-4147-af2a-317882e2a722",
  };
  const github = {
    installation_id: installationId,
    installation_generation: 1,
    mapping_revision: 2,
    cursor_generation: 0,
    cursor_position: null,
    credential_kind: "github_installation",
    credential_ref: "ce3aa096-d372-4a35-a886-17338d660d38",
    credential_material_revision: null,
  };

  it("preserves the nullable GitHub cursor and credential revision", async () => {
    const { client, fetch } = clientWithResponse([github]);

    await expect(readConnectorSubscription(client, resource)).resolves.toEqual(github);

    const request = new Request(...fetch.mock.calls[0]!);
    expect(new URL(request.url).pathname).toBe("/rest/v1/rpc/read_connector_subscription");
    expect(await request.json()).toEqual({
      p_workspace_id: resource.workspaceId,
      p_factory_id: resource.factoryId,
      p_resource_id: resource.resourceId,
    });
  });

  it("reads the verified Linear credential revision and selected stream cursor", async () => {
    const linear = {
      ...github,
      credential_kind: "workspace_secret",
      credential_material_revision: 4,
      cursor_generation: 2,
      cursor_position: "provider-cursor",
    };
    const { client, fetch } = clientWithResponse([linear]);

    await expect(
      readConnectorSubscription(client, { ...resource, stream: "polling" }),
    ).resolves.toEqual(linear);
    const request = new Request(...fetch.mock.calls[0]!);
    expect(await request.json()).toMatchObject({ p_stream: "polling" });
  });

  it("returns null when the source has no live subscription", async () => {
    const { client } = clientWithResponse([]);

    await expect(readConnectorSubscription(client, resource)).resolves.toBeNull();
  });

  it("rejects a Linear credential reference without a material revision", async () => {
    const { client } = clientWithResponse([{ ...github, credential_kind: "workspace_secret" }]);

    await expect(readConnectorSubscription(client, resource)).rejects.toThrow();
  });
});
