import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { drainFactoryEventDeliveries } from "@/lib/factory-event-subscriptions/dispatch";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

vi.mock("@/lib/factory-event-subscriptions/dispatch", () => ({
  drainFactoryEventDeliveries: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));

const secret = "a".repeat(64);
const target = "https://wallie.example/api/internal/factory-event-dispatch";
const headers = { Authorization: `Bearer ${secret}` };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WALLIE_FACTORY_EVENT_DISPATCH_RELAY_SECRET", secret);
});
afterEach(() => vi.unstubAllEnvs());

it("requires the dedicated relay credential before opening any privileged lane", async () => {
  vi.stubEnv("WALLIE_WORKER_WAKE_SECRET", "b".repeat(64));
  const wrong = new Request(target, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(64)}` },
  });
  expect((await POST(wrong)).status).toBe(401);
  vi.stubEnv("WALLIE_FACTORY_EVENT_DISPATCH_RELAY_SECRET", "");
  expect((await POST(new Request(target, { method: "POST", headers }))).status).toBe(404);
  expect(createSupabaseAdminClient).not.toHaveBeenCalled();
});

it("refuses caller-selected delivery parameters, including an arbitrary endpoint", async () => {
  expect(
    (
      await POST(
        new Request(target, {
          method: "POST",
          headers,
          body: JSON.stringify({ endpoint: "https://somewhere.example/" }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await POST(new Request(`${target}?delivery=secret`, { method: "POST", headers }))).status,
  ).toBe(400);
  expect(drainFactoryEventDeliveries).not.toHaveBeenCalled();
});

it("uses the shared durable sender without returning outbound data", async () => {
  const body = new ReadableStream<Uint8Array>({ start: (stream) => stream.close() });
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, duplex: "half" };
  const response = await POST(new Request(target, init));
  expect(response.status).toBe(204);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("");
  expect(createSupabaseAdminClient).toHaveBeenCalledOnce();
  expect(drainFactoryEventDeliveries).toHaveBeenCalledOnce();
});
