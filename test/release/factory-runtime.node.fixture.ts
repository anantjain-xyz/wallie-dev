import assert from "node:assert/strict";

import { it, vi } from "vitest";

import { parseWorkerConfig } from "@/worker/config";
import { claimNextJob, runClaimedJob } from "@/worker/loop";

import { createFactoryRuntimeClients, qualifyFactoryRuntime } from "./factory-runtime-fixture";
import { createFactoryRuntimeTransport } from "./factory-runtime-transport";

const hosted = vi.hoisted(() => ({ driver: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/sandbox/provider-contract", async (original) => ({
  ...(await original<typeof import("@/lib/sandbox/provider-contract")>()),
  loadSandboxProviderDriver: hosted.driver,
}));
vi.mock("@/features/github/sandbox-token", () => ({ mintSandboxRepositoryToken: hosted.token }));

it("qualifies actual factory execution and revocation through a Node worker claim", async () => {
  const raw = process.env.WALLIE_FACTORY_RUNTIME_FIXTURE;
  assert(raw, "Run via the disposable factory runtime qualification command.");
  const { admin, viewer } = createFactoryRuntimeClients(raw);
  const transport = createFactoryRuntimeTransport();
  hosted.driver.mockImplementation(async (provider: string) => {
    assert.equal(provider, "e2b");
    return transport.driver;
  });
  hosted.token.mockResolvedValue("synthetic-local-checkout-token");

  await qualifyFactoryRuntime({
    admin,
    viewer,
    runtime: "node",
    transport,
    execute: async (expected) => {
      const claim = await claimNextJob(admin, parseWorkerConfig());
      assert.equal(claim.outcome, "claimed");
      assert.equal(claim.job.id, expected.job_id, "The Node worker must claim the fixture job.");
      await runClaimedJob(admin, claim.job, { captureOrderedEvents: true, timeoutMs: 30000 });
    },
  });
});
