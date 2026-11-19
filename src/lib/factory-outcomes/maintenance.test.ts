import { expect, it, vi } from "vitest";

import { processFactoryFlowProjection } from "./maintenance";

it("processes exactly one bounded batch even if more work remains", async () => {
  const data = { processed: 25, hasMore: true };
  const abortSignal = vi.fn().mockResolvedValue({ data, error: null });
  const rpc = vi.fn().mockReturnValue({ abortSignal });

  await expect(processFactoryFlowProjection({ rpc })).resolves.toEqual(data);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("process_factory_flow_projection", { p_limit: 25 });
  expect(abortSignal).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
});

it.each([
  { data: null, error: { message: "Private maintenance failure" } },
  { data: { processed: 26, hasMore: true }, error: null },
])("reports unavailable maintenance for invalid RPC results", async (response) => {
  const rpc = vi.fn().mockReturnValue({ abortSignal: vi.fn().mockResolvedValue(response) });

  await expect(processFactoryFlowProjection({ rpc })).rejects.toThrow(
    "Could not process factory flow projections.",
  );
});
