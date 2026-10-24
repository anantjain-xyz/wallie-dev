import { afterEach, expect, it, vi } from "vitest";
import { wakeWorker } from "./wake";

afterEach(() => vi.unstubAllGlobals());
const config = {
  WALLIE_WORKER_WAKE_URL: "https://worker.example/internal/wake",
  WALLIE_WORKER_WAKE_SECRET: "synthetic-wake-secret-at-least-32-characters",
};
it("sends only an authenticated wake-up with a bounded timeout", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  await wakeWorker(config);
  expect(fetch).toHaveBeenCalledWith(
    config.WALLIE_WORKER_WAKE_URL,
    expect.objectContaining({
      method: "POST",
      headers: { Authorization: `Bearer ${config.WALLIE_WORKER_WAKE_SECRET}` },
      redirect: "manual",
      signal: expect.any(AbortSignal),
    }),
  );
  expect(fetch.mock.calls[0][1]).not.toHaveProperty("body");
});
it("preserves enqueue success when the worker is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
  await expect(wakeWorker(config)).resolves.toBeUndefined();
});
it("skips local deployments and rejects credential-bearing or insecure remote URLs", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await wakeWorker({});
  await wakeWorker({ ...config, WALLIE_WORKER_WAKE_URL: "http://remote.example/internal/wake" });
  await wakeWorker({
    ...config,
    WALLIE_WORKER_WAKE_URL: "https://token@remote.example/internal/wake",
  });
  expect(fetch).not.toHaveBeenCalled();
});
