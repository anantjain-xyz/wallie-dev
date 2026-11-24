import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { configureConnectorInstallation } from "./installations";

const scope = {
  workspaceId: "e9af51b6-77e3-4fd9-82ef-4310d27fdd84",
  factoryId: "5a50927d-3124-4daf-a337-2ced19866412",
  actorUserId: "2897bd8a-918e-46b9-af5f-4cf8bc7f089f",
  expectedGeneration: 0,
};
const installationId = "4b4c5fb5-d98b-456c-ae9a-a80e9bcbe670";

function clientWithReceipt() {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json([{ installation_id: installationId, generation: 1 }]));
  const client = createClient<Database>("https://database.example.test", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  return { client, fetch };
}

describe("configureConnectorInstallation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("encrypts Slack credential material before the database request", async () => {
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "connector-test-encryption-key");
    const { client, fetch } = clientWithReceipt();
    const credential = "synthetic-slack-credential";

    await expect(
      configureConnectorInstallation(client, {
        ...scope,
        installation: {
          provider: "slack",
          externalTenantId: "T123",
          externalInstallationId: "A234",
          credential,
        },
      }),
    ).resolves.toEqual({ installationId, generation: 1 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = new Request(...fetch.mock.calls[0]!);
    expect(new URL(request.url).pathname).toBe("/rest/v1/rpc/configure_connector_installation");
    const body = await request.text();
    expect(body).not.toContain(credential);
    const args = JSON.parse(body);
    expect(args).toMatchObject({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: scope.actorUserId,
      p_expected_generation: 0,
      p_provider: "slack",
      p_external_tenant_id: "T123",
      p_external_installation_id: "A234",
    });
    expect(args).not.toHaveProperty("p_linear_secret_id");
    expect(args).not.toHaveProperty("p_linear_material_revision");
    expect(decryptSecretValue(args.p_encrypted_credential)).toBe(credential);
  });

  it("lets the database resolve the existing GitHub installation", async () => {
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", undefined);
    const { client, fetch } = clientWithReceipt();

    await configureConnectorInstallation(client, {
      ...scope,
      installation: {
        provider: "github",
        externalTenantId: "fixture-github-tenant",
        externalInstallationId: "123",
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = new Request(...fetch.mock.calls[0]!);
    const args = await request.json();
    expect(args).not.toHaveProperty("p_encrypted_credential");
    expect(args).not.toHaveProperty("p_linear_secret_id");
    expect(args).not.toHaveProperty("p_linear_material_revision");
  });

  it("sends the exact verified Linear secret reference and material revision", async () => {
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", undefined);
    const { client, fetch } = clientWithReceipt();
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
    const args = await request.json();
    expect(args).toMatchObject({ p_linear_secret_id: secretId, p_linear_material_revision: 4 });
    expect(args).not.toHaveProperty("p_encrypted_credential");
  });
});
