import { expect, it, vi } from "vitest";

import { processFactoryRoutingCanaryAlerts } from "./canary-alert-maintenance";

it("evaluates one bounded batch and returns the alert counts", async () => {
  const data = { evaluated: 8, created: 3 };
  const abortSignal = vi.fn().mockResolvedValue({ data, error: null });
  const rpc = vi.fn().mockReturnValue({ abortSignal });

  await expect(processFactoryRoutingCanaryAlerts({ rpc })).resolves.toEqual(data);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("process_factory_routing_canary_alerts", {
    p_limit: 8,
  });
  expect(abortSignal).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
});

it.each([
  { data: null, error: { message: "Private storage error" } },
  { data: { evaluated: 9, created: 0 }, error: null },
  { data: { evaluated: 1, created: 4 }, error: null },
])("rejects a failed or inconsistent maintenance result", async (response) => {
  const rpc = vi.fn().mockReturnValue({ abortSignal: vi.fn().mockResolvedValue(response) });

  await expect(processFactoryRoutingCanaryAlerts({ rpc })).rejects.toThrow(
    "Could not evaluate routing canary degradation.",
  );
});
