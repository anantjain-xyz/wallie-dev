import assert from "node:assert/strict";

import { it, vi } from "vitest";

import { runFactoryJudge } from "@/lib/factory-evaluations/judge";
import { drainFactoryJudges } from "@/lib/factory-evaluations/judge-worker";
import { maintainFactoryEvaluationQueue } from "@/lib/factory-evaluations/maintenance";
import { processFactoryScorerSampling } from "@/lib/factory-scorers/sampling-maintenance";
import type { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { parseWorkerConfig } from "@/worker/config";
import { claimNextJob, runClaimedJob } from "@/worker/loop";

import { createM05ContextProvider } from "./factory-m05-inputs";
import { createFactoryMediaQualificationBroker } from "./factory-media-qualification-broker";
import { runAuthenticatedBrowserQualification } from "./factory-media-qualification-browser";
import { createFactoryRuntimeClients, qualifyFactoryRuntime } from "./factory-runtime-fixture";
import { createFactoryRuntimeTransport } from "./factory-runtime-transport";
import { createFactoryScorerRuntimeProvider } from "./factory-scorer-runtime-provider";
import {
  SCORER_FIXTURE_JUDGE_KEY,
  SCORER_FIXTURE_JUDGE_MODEL,
  SCORER_FIXTURE_JUDGE_PROVIDER,
  type FactoryScorerExpectedJudgeInput,
} from "./factory-scorer-runtime-fixture";
import { runFactoryScorerQualificationBrowser } from "./factory-scorer-qualification-browser";

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
      ...(judge
        ? {
            m07: {
              judge,
              maintain: async () => {
                await processFactoryScorerSampling(admin);
                await maintainFactoryEvaluationQueue(admin);
                await drainFactoryJudges(admin, "node");
              },
              inspectScore: async (fixture) => {
                const appUrl = process.env.WALLIE_FACTORY_SCORER_BROWSER_URL;
                assert(appUrl, "The scorer qualification needs a local Wallie app.");
                await runFactoryScorerQualificationBrowser(fixture, {
                  appUrl,
                  proofDir: process.env.WALLIE_FACTORY_SCORER_PROOF_DIR,
                  supabaseUrl: config.url,
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

const expectedJudgeInput = {
  rubric: "Confirm the exact retained qualification artifact.",
  artifactId: "61000000-0000-4000-8000-000000000001",
  artifact: "# Exact qualification artifact\n\nThe retained Markdown includes this full body.",
} satisfies FactoryScorerExpectedJudgeInput;

function runFixedJudge(
  provider: ReturnType<typeof createFactoryScorerRuntimeProvider>,
  input = expectedJudgeInput,
) {
  return runFactoryJudge({
    definition: {
      schemaVersion: 1,
      rubric: input.rubric,
      requiredEvidence: ["artifact"],
      scoring: { kind: "boolean", passValue: true },
    },
    evidence: [
      {
        reference: { kind: "artifact", id: input.artifactId },
        mediaType: "text/plain",
        text: input.artifact,
      },
    ],
    profile: {
      model: SCORER_FIXTURE_JUDGE_MODEL,
      provider: SCORER_FIXTURE_JUDGE_PROVIDER,
      allowImage: false,
      allowVideo: false,
    },
    apiKey: SCORER_FIXTURE_JUDGE_KEY,
    signal: new AbortController().signal,
    fetcher: (request, options) => {
      const response = provider.fixtureFetch(request, options);
      assert(response, "The fixed judge received an unexpected endpoint.");
      return response;
    },
  });
}

it("fixed scorer transport accepts the exact scheduled input", async () => {
  const provider = createFactoryScorerRuntimeProvider();
  const inspect = vi.fn(async () => undefined);
  const verify = provider.respond(expectedJudgeInput, "pass", inspect);
  assert.equal((await runFixedJudge(provider)).result.status, "pass");
  verify();
  assert.equal(provider.requestCount(), 1);
  assert.equal(inspect.mock.calls.length, 1);
});

it.each([
  { field: "artifact", value: "A different artifact with the same ID." },
  { field: "rubric", value: "A different rubric revision." },
  { field: "artifactId", value: "61000000-0000-4000-8000-000000000002" },
])("fixed scorer transport rejects a mismatched $field", async ({ field, value }) => {
  const provider = createFactoryScorerRuntimeProvider();
  const inspect = vi.fn(async () => undefined);
  const verify = provider.respond(expectedJudgeInput, "pass", inspect);
  const result = await runFixedJudge(provider, { ...expectedJudgeInput, [field]: value });
  assert.equal(result.result.status, "error");
  assert.throws(verify, /exact pinned rubric and retained artifact/);
  assert.equal(provider.requestCount(), 1);
  assert.equal(inspect.mock.calls.length, 0);
});

it("fixed scorer transport surfaces a failed inspection through its verifier", async () => {
  const provider = createFactoryScorerRuntimeProvider();
  const failedInspection = new Error("The simulated native callback failed.");
  const verify = provider.respond(expectedJudgeInput, "pass", async () => {
    throw failedInspection;
  });
  assert.equal((await runFixedJudge(provider)).result.status, "error");
  assert.throws(verify, (error: unknown) => error === failedInspection);
});

it("fixed scorer transport counts and rejects an unscheduled replay", async () => {
  const provider = createFactoryScorerRuntimeProvider();
  const verify = provider.respond(expectedJudgeInput, "pass");
  assert.equal((await runFixedJudge(provider)).result.status, "pass");
  verify();
  assert.equal((await runFixedJudge(provider)).result.status, "error");
  assert.equal(provider.requestCount(), 2);
  assert.throws(verify, /unscheduled provider request/);
});
