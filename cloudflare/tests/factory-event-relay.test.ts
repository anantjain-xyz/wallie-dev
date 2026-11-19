import { afterEach, expect, it, vi } from "vitest";

import { requestFactoryEventDispatch } from "@/lib/factory-event-subscriptions/relay";

const url = "https://wallie.example/api/internal/factory-event-dispatch";
const secret = "a".repeat(64);
const config = {
  WALLIE_FACTORY_EVENT_DISPATCH_RELAY_URL: url,
  WALLIE_FACTORY_EVENT_DISPATCH_RELAY_SECRET: secret,
};

afterEach(() => vi.restoreAllMocks());

it("uses the fixed authenticated Node operation from Workerd without sending data", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  await requestFactoryEventDispatch(config);
  expect(send).toHaveBeenCalledExactlyOnceWith(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
});

it("fails closed for an unconfigured, wrong-path or unavailable relay", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  await requestFactoryEventDispatch({});
  await expect(
    requestFactoryEventDispatch({
      ...config,
      WALLIE_FACTORY_EVENT_DISPATCH_RELAY_URL: "https://wallie.example/other",
    }),
  ).rejects.toThrow("Invalid event dispatch relay configuration.");
  await expect(
    requestFactoryEventDispatch({ WALLIE_FACTORY_EVENT_DISPATCH_RELAY_URL: url }),
  ).rejects.toThrow("The event dispatch relay is unavailable.");
  expect(send).not.toHaveBeenCalled();
  await expect(requestFactoryEventDispatch(config)).rejects.toThrow(
    "The event dispatch relay could not complete.",
  );
  expect(send).toHaveBeenCalledOnce();
});
