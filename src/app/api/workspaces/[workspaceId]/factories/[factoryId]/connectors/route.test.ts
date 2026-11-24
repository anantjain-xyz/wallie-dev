import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getDeliveries } from "./[resourceId]/deliveries/route";
import { POST as retryDelivery } from "./[resourceId]/deliveries/retry/route";
import { GET as getInventory } from "./route";

const mock = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/factories/route-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/factories/route-context")>()),
  resolveFactoryRouteContext: mock.resolveScope,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mock.rpc }),
}));

const workspaceId = "68000000-0000-4000-8000-000000000001";
const factoryId = "68000000-0000-4000-8000-000000000002";
const resourceId = "68000000-0000-4000-8000-000000000003";
const userId = "68000000-0000-4000-8000-000000000004";
const deliveryId = "68000000-0000-4000-8000-000000000005";
const origin = "https://wallie.example.test/";
const context = { params: Promise.resolve({ workspaceId, factoryId, resourceId }) };
const factoryScope = {
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_actor_user_id: userId,
};
const deliveryScope = { ...factoryScope, p_resource_id: resourceId };
const emptyInventory = { canConfigure: false, installations: [], resources: [] };
const emptyProjection = { deliveries: [], nextCursor: null, linearDiscovery: null };

function write(command: unknown) {
  return new Request(origin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

describe("factory connector diagnostics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.resolveScope.mockResolvedValue({
      ok: true,
      workspaceId,
      factoryId,
      access: { user: { id: userId } },
    });
  });

  it("returns scoped inventory using the authenticated actor and private response headers", async () => {
    mock.rpc.mockResolvedValueOnce({ data: emptyInventory, error: null });

    const response = await getInventory(new Request(origin), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(emptyInventory);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith(
      "list_factory_connector_resources",
      factoryScope,
    );
  });

  it("rejects a response containing a credential reference", async () => {
    mock.rpc.mockResolvedValueOnce({
      data: { ...emptyInventory, credentialRef: "hidden" },
      error: null,
    });

    const response = await getInventory(new Request(origin), context);

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("hidden");
  });

  it("honors a database permission denial without returning provider error text", async () => {
    mock.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "Private provider detail" },
    });

    const response = await getDeliveries(new Request(origin), context);

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Private provider detail");
  });

  it("round-trips a typed keyset cursor within the exact resource scope", async () => {
    const nextCursor = { recordedAt: "2026-11-24T00:00:00Z", kind: "outbound", id: deliveryId };
    mock.rpc
      .mockResolvedValueOnce({ data: { ...emptyProjection, nextCursor }, error: null })
      .mockResolvedValueOnce({ data: emptyProjection, error: null });

    const first = await getDeliveries(new Request(`${origin}?lane=outbound&limit=5`), context);
    const page = await first.json();
    expect(first.status).toBe(200);
    expect(typeof page.nextCursor).toBe("string");
    expect(JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"))).toEqual(
      nextCursor,
    );

    const second = await getDeliveries(
      new Request(`${origin}?lane=outbound&limit=5&cursor=${page.nextCursor}`),
      context,
    );
    expect(second.status).toBe(200);
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "list_factory_connector_deliveries", {
      ...deliveryScope,
      p_lane: "outbound",
      p_limit: 5,
    });
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "list_factory_connector_deliveries", {
      ...deliveryScope,
      p_lane: "outbound",
      p_limit: 5,
      p_before_at: nextCursor.recordedAt,
      p_before_kind: nextCursor.kind,
      p_before_id: nextCursor.id,
    });
  });

  it("rejects an oversized window and malformed path or cursor before invoking the RPC", async () => {
    expect((await getDeliveries(new Request(`${origin}?limit=51`), context)).status).toBe(400);
    expect((await getDeliveries(new Request(`${origin}?cursor=not_json`), context)).status).toBe(
      400,
    );
    expect(
      (
        await getDeliveries(new Request(origin), {
          params: Promise.resolve({ workspaceId, factoryId, resourceId: "wrong" }),
        })
      ).status,
    ).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("schedules only the selected logical row and handles a stale retry without writing again", async () => {
    mock.rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });

    const command = { kind: "outbound", id: deliveryId, mode: "observe" };
    const accepted = await retryDelivery(write(command), context);
    expect(await accepted.json()).toEqual({ scheduled: true });
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "retry_factory_connector_delivery", {
      ...deliveryScope,
      p_kind: command.kind,
      p_delivery_id: deliveryId,
      p_mode: command.mode,
    });
    expect((await retryDelivery(write(command), context)).status).toBe(409);
    expect(mock.rpc).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported modes and lanes, caller-supplied actors and non-JSON retries", async () => {
    expect(
      (
        await retryDelivery(
          write({ kind: "github_admission", id: deliveryId, mode: "retry" }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await retryDelivery(
          write({ kind: "outbound", id: deliveryId, mode: "retry", actor: userId }),
          context,
        )
      ).status,
    ).toBe(400);
    expect((await retryDelivery(write({ kind: "outbound", id: deliveryId }), context)).status).toBe(
      400,
    );
    expect(
      (
        await retryDelivery(
          write({ kind: "github_comment", id: deliveryId, mode: "observe" }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (await retryDelivery(new Request(origin, { method: "POST", body: "not JSON" }), context))
        .status,
    ).toBe(415);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
