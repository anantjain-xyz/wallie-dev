import assert from "node:assert/strict";
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it, vi } from "vitest";

import type { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { createM05ContextProvider } from "../../test/release/factory-m05-inputs";
import {
  createFactoryRuntimeClients,
  qualifyFactoryRuntime,
} from "../../test/release/factory-runtime-fixture";
import { createFactoryRuntimeTransport } from "../../test/release/factory-runtime-transport";
import { createFactoryScorerRuntimeProvider } from "../../test/release/factory-scorer-runtime-provider";
import type { Env } from "../index";

const hosted = vi.hoisted(() => ({ driver: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/sandbox/provider-contract", async (original) => ({
  ...(await original<typeof import("@/lib/sandbox/provider-contract")>()),
  loadSandboxProviderDriver: hosted.driver,
}));
vi.mock("@/features/github/sandbox-token", () => ({ mintSandboxRepositoryToken: hosted.token }));

const bindings = env as unknown as Env;
const raw = bindings.WALLIE_FACTORY_RUNTIME_FIXTURE;

it.skipIf(typeof raw !== "string")(
  "qualifies actual factory execution and revocation through the native attempt workflow",
  async () => {
    assert(typeof raw === "string");
    const { admin, viewer, config } = createFactoryRuntimeClients(raw);
    const transport = createFactoryRuntimeTransport();
    const upstream = config.m05 ? createM05ContextProvider() : undefined;
    const judge = config.m07 ? createFactoryScorerRuntimeProvider() : undefined;
    hosted.driver.mockImplementation(async (provider: string) => {
      assert.equal(provider, "e2b");
      return transport.driver;
    });
    hosted.token.mockImplementation(
      async (request: Parameters<typeof mintSandboxRepositoryToken>[0]) =>
        upstream?.mintToken(request) ?? "synthetic-local-checkout-token",
    );
    if (upstream || judge) {
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (request: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const fixed = judge?.fixtureFetch(request, init) ?? upstream?.fixtureFetch(request, init);
        if (fixed) return fixed;
        if (judge) {
          const url = new URL(request instanceof Request ? request.url : String(request));
          assert.equal(
            url.origin,
            new URL(config.url).origin,
            "The scorer fixture only fetches its local database.",
          );
        }
        return originalFetch(request, init);
      });
    }

    try {
      await qualifyFactoryRuntime({
        admin,
        viewer,
        runtime: "workerd",
        transport,
        ...(upstream ? { m05: { upstream } } : {}),
        ...(judge
          ? {
              m07: {
                judge,
                maintain: async () => {
                  const id = `scorer-runtime-${crypto.randomUUID()}`;
                  const workflow = await bindings.MAINTENANCE.create({
                    id,
                    params: { tick: Date.now() },
                  });
                  try {
                    const terminal = await vi.waitFor(
                      async () => {
                        const status = await workflow.status();
                        assert(
                          ["complete", "errored", "terminated"].includes(status.status),
                          `Native scorer maintenance is ${status.status}.`,
                        );
                        return status;
                      },
                      { timeout: 15_000, interval: 50 },
                    );
                    assert.equal(terminal.status, "complete", terminal.error?.message);
                  } catch (error) {
                    await workflow.terminate().catch(() => {});
                    throw error;
                  }
                },
              },
            }
          : {}),
        execute: async (expected) => {
          const result = await admin.rpc("claim_next_worker_dispatch", { p_timeout_ms: 30000 });
          assert(!result.error, result.error?.message);
          const [dispatch] = result.data ?? [];
          assert(dispatch);
          assert.equal(
            dispatch.job_id,
            expected.job_id,
            "The native workflow must claim the fixture job.",
          );
          const id = dispatch.workflow_id;
          const instance = await introspectWorkflowInstance(bindings.SESSION_ATTEMPT, id);
          try {
            await bindings.SESSION_ATTEMPT.create({
              id,
              params: {
                jobId: dispatch.job_id,
                attemptCount: dispatch.attempt_count,
                workflowId: id,
              },
            });
            await instance.waitForStatus("complete");
          } finally {
            await instance.dispose();
          }
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  },
  120_000,
);
