import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeFactoryEventSubscriptionCommand } from "./management";

const { rpc, prove, encrypt } = vi.hoisted(() => ({
  rpc: vi.fn(),
  prove: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc }),
}));
vi.mock("@/lib/secrets/crypto", () => ({ encryptSecretValue: encrypt }));
vi.mock("./transport", () => ({ proveFactoryEventDestination: prove }));

const scope = { workspaceId: "workspace", factoryId: "factory", actorUserId: "manager" };
const subscriptionId = "11111111-2222-4333-8444-555555555555";
const destination = "https://receiver.example.com/receive";
const create = {
  action: "create",
  name: "Fixture receiver",
  destination,
  credentialKind: "machine_token",
  credentialId: "token",
  eventTypes: ["review.ready"],
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  encrypt.mockReturnValue("encrypted-at-rest");
  rpc.mockImplementation((name: string) =>
    name === "begin_factory_event_subscription_verification"
      ? {
          maybeSingle: async () => ({
            data: { endpoint_url: destination, subscription_revision: 1 },
            error: null,
          }),
        }
      : Promise.resolve({
          data: name === "create_factory_event_subscription" ? subscriptionId : true,
          error: null,
        }),
  );
});

describe("factory event subscription management", () => {
  it("returns the signing secret once, persists only encrypted bytes and sends no event", async () => {
    const result = await executeFactoryEventSubscriptionCommand(scope, {
      ...create,
      eventTypes: [...create.eventTypes],
    });

    expect(result.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(encrypt).toHaveBeenCalledExactlyOnceWith(result.signingSecret);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "create_factory_event_subscription",
      expect.objectContaining({
        p_workspace_id: scope.workspaceId,
        p_factory_id: scope.factoryId,
        p_actor_user_id: scope.actorUserId,
        p_endpoint_url: destination,
        p_signing_secret_encrypted: "encrypted-at-rest",
      }),
    );
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(result.signingSecret);
    expect(prove).not.toHaveBeenCalled();
  });

  it("activates only after a proof against the database's stored endpoint and exact digest", async () => {
    prove.mockResolvedValue(true);

    await expect(
      executeFactoryEventSubscriptionCommand(scope, { action: "verify", subscriptionId }),
    ).resolves.toEqual({ verified: true });

    const [[probe]] = prove.mock.calls;
    const digest = createHash("sha256").update(probe.challenge).digest("hex");
    expect(probe).toEqual({
      url: destination,
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "begin_factory_event_subscription_verification",
      expect.objectContaining({
        p_subscription_id: subscriptionId,
        p_verification_digest: digest,
      }),
    );
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "confirm_factory_event_subscription",
      rpc.mock.calls[0][1],
    );
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("keeps a failed ownership proof pending", async () => {
    prove.mockResolvedValue(false);

    await expect(
      executeFactoryEventSubscriptionCommand(scope, { action: "verify", subscriptionId }),
    ).rejects.toMatchObject({ status: 422 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not report success if the exact authority changes before confirmation", async () => {
    prove.mockResolvedValue(true);
    rpc.mockImplementationOnce(() => ({
      maybeSingle: async () => ({ data: { endpoint_url: destination }, error: null }),
    }));
    rpc.mockResolvedValueOnce({ data: false, error: null });

    await expect(
      executeFactoryEventSubscriptionCommand(scope, { action: "verify", subscriptionId }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
