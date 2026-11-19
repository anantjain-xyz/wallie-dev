import assert from "node:assert/strict";

import { it, vi } from "vitest";

import type { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { parseWorkerConfig } from "@/worker/config";
import { claimNextJob, runClaimedJob } from "@/worker/loop";

import { createM05ContextProvider } from "./factory-m05-inputs";
import { createFactoryMediaQualificationBroker } from "./factory-media-qualification-broker";
import { runAuthenticatedBrowserQualification } from "./factory-media-qualification-browser";
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
  const { admin, viewer, config } = createFactoryRuntimeClients(raw);
  const transport = createFactoryRuntimeTransport();
  const upstream = config.m05 ? createM05ContextProvider() : undefined;
  hosted.driver.mockImplementation(async (provider: string) => {
    assert.equal(provider, "e2b");
    return transport.driver;
  });
  hosted.token.mockImplementation(
    async (request: Parameters<typeof mintSandboxRepositoryToken>[0]) =>
      upstream?.mintToken(request) ?? "synthetic-local-checkout-token",
  );

  if (upstream) {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (request: Parameters<typeof fetch>[0], init?: RequestInit) =>
        upstream.fixtureFetch(request, init) ?? originalFetch(request, init),
    );
  }
  try {
    await qualifyFactoryRuntime({
      admin,
      viewer,
      runtime: "node",
      transport,
      ...(upstream
        ? {
            m05: {
              upstream,
              inspectReview: async (fixture) => {
                const appUrl = process.env.WALLIE_FACTORY_MEDIA_BROWSER_URL;
                assert(appUrl, "The opt-in media qualification needs a local Wallie app.");
                await runAuthenticatedBrowserQualification(fixture, {
                  appUrl,
                  proofDir: process.env.WALLIE_FACTORY_MEDIA_PROOF_DIR,
                  supabaseUrl: config.url,
                  serviceKey: config.serviceKey,
                  publishableKey: config.publishableKey,
                });
              },
            },
          }
        : {}),
      execute: async (expected, browser) => {
        const claim = await claimNextJob(admin, parseWorkerConfig());
        assert.equal(claim.outcome, "claimed");
        assert.equal(claim.job.id, expected.job_id, "The Node worker must claim the fixture job.");
        const options = { captureOrderedEvents: true, timeoutMs: 30000 };
        if (!browser) {
          await runClaimedJob(admin, claim.job, options);
          return;
        }
        const broker = await createFactoryMediaQualificationBroker();
        try {
          await runClaimedJob(admin, claim.job, { ...options, ...broker.forRun(browser) });
          const terminal = await admin
            .from("agent_jobs")
            .select("status,last_error")
            .eq("id", expected.job_id)
            .single();
          assert(!terminal.error, terminal.error?.message);
          assert.equal(terminal.data?.status, "success", terminal.data?.last_error ?? undefined);
          assert.deepEqual(broker.activity(), { authorizedRequests: 2, documentReads: 2 });
        } finally {
          await broker.close();
        }
      },
    });
  } finally {
    vi.unstubAllGlobals();
  }
}, 120_000);
