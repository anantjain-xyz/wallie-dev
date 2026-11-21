import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { runFactoryJudge } from "./judge";
import type { FactoryJudgeClaim } from "./judge-inputs";
import { runClaimedFactoryJudge } from "./judge-worker";

vi.mock("./judge", () => ({ runFactoryJudge: vi.fn() }));

function id(slot: number) {
  return `60500000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
}

const profileId = id(11);
const artifactId = id(12);
const trialId = id(13);
const validationText = '{"status":"passed","checks":["invoice totals match"]}';
const exampleKey = "synthetic-dedicated-judge-key";

function fixture(
  permitStatus = "authorized",
  kind: "artifact" | "validation_report" = "artifact",
  benchmark?: { evidenceId?: string; reportDigest?: string },
) {
  const claim: FactoryJudgeClaim = {
    workspace_id: id(1),
    factory_id: id(2),
    job_id: id(3),
    session_id: id(4),
    run_id: id(5),
    scorer_revision_id: id(6),
    sample_receipt_id: id(7),
    target_commit_sha: "a".repeat(40),
    attempt_id: id(8),
    attempt_number: 1,
    lease_id: id(9),
    lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
  };
  const definition = {
    schemaVersion: 1,
    rubric: "Check the exact retained report summary.",
    requiredEvidence: [kind],
    scoring: { kind: "boolean", passValue: true },
  };
  let evidence;
  if (kind === "artifact") {
    evidence = {
      kind,
      id: benchmark ? (benchmark.evidenceId ?? trialId) : artifactId,
      content_md: "Result summary",
    };
  } else if (benchmark) {
    evidence = {
      kind,
      id: benchmark.evidenceId ?? trialId,
      source: "benchmark_result",
      content_text: validationText,
      sha256: benchmark.reportDigest ?? createHash("sha256").update(validationText).digest("hex"),
    };
  } else {
    evidence = {
      kind,
      id: artifactId,
      workspace_id: claim.workspace_id,
      session_id: claim.session_id,
      run_id: claim.run_id,
      storage_path: `${claim.workspace_id}/${claim.run_id}/${artifactId}`,
      sha256: "0".repeat(64),
      content_type: "text/plain",
      size_bytes: 10,
    };
  }
  const requests: { rpc: string; body: unknown }[] = [];
  const admin = createClient<Database>("https://evaluation.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const rpc = new URL(request.url).pathname.split("/").at(-1) ?? "";
        if (rpc === "session_validation_asset_withholdings") {
          return Response.json({ code: "PGRST000" }, { status: 503 });
        }
        const body: unknown = await request.json();
        requests.push({ rpc, body });
        if (rpc === "prepare_factory_judge_invocation") {
          return Response.json({
            status: "ready",
            profile: {
              id: profileId,
              workspace_id: claim.workspace_id,
              revision: 1,
              enabled: true,
              provider: "openrouter",
              model_id: "vendor/model",
              provider_route: "vendor",
              allow_images: false,
              allow_video: false,
              created_at: "2026-11-20T00:00:00Z",
            },
            definition,
            target_commit_sha: claim.target_commit_sha,
            run_id: claim.run_id,
            session_id: claim.session_id,
            sample_receipt_id: claim.sample_receipt_id,
            scorer_revision_id: claim.scorer_revision_id,
            evidence: [evidence],
            ...(benchmark
              ? { benchmark_source: { trial_id: trialId, result_digest: "a".repeat(64) } }
              : {}),
          });
        }
        if (rpc === "begin_factory_judge_invocation") {
          return Response.json(
            permitStatus === "authorized"
              ? { status: "authorized", encrypted_api_key: encryptSecretValue(exampleKey) }
              : permitStatus === "benchmark_blocked"
                ? { status: permitStatus, reason: "evaluation_budget_exhausted" }
                : { status: permitStatus },
          );
        }
        if (rpc === "finish_factory_judge_invocation") return Response.json(true);
        throw new Error("Unexpected fixture RPC.");
      },
    },
  });
  return { admin, claim, requests, definition };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WALLIE_ENCRYPTION_KEY", "wallie-synthetic-encryption-input-for-judge-test");
});
afterEach(() => vi.unstubAllEnvs());

it.each(["node", "workerd"] as const)(
  "evaluates a digest-checked private benchmark report through the %s claim path",
  async (runtime) => {
    const { admin, claim, requests } = fixture("authorized", "validation_report", {});
    vi.mocked(runFactoryJudge).mockResolvedValue({
      result: {
        schemaVersion: 1,
        evidence: [{ kind: "validation_report", id: trialId }],
        status: "pass",
        score: { kind: "boolean", value: true },
      },
    });

    await expect(runClaimedFactoryJudge(admin, claim, runtime)).resolves.toBe(true);
    expect(runFactoryJudge).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        evidence: [
          {
            mediaType: "text/plain",
            reference: { kind: "validation_report", id: trialId },
            text: validationText,
          },
        ],
      }),
    );
    expect(requests[1]).toMatchObject({
      rpc: "begin_factory_judge_invocation",
      body: { p_worker_runtime: runtime },
    });
  },
);

it("withholds a benchmark report when its bytes differ from the retained digest", async () => {
  const { admin, claim, requests } = fixture("authorized", "validation_report", {
    reportDigest: "1".repeat(64),
  });

  await expect(runClaimedFactoryJudge(admin, claim, "node")).resolves.toBe(true);
  expect(requests.map(({ rpc }) => rpc)).toEqual([
    "prepare_factory_judge_invocation",
    "finish_factory_judge_invocation",
  ]);
  expect(requests[1]?.body).toMatchObject({ p_status: "unsupported_evidence" });
  expect(runFactoryJudge).not.toHaveBeenCalled();
});

it("withholds a benchmark artifact associated with another trial", async () => {
  const { admin, claim, requests } = fixture("authorized", "artifact", { evidenceId: id(14) });

  await expect(runClaimedFactoryJudge(admin, claim, "node")).rejects.toThrow(
    "The factory judge evidence did not match its source.",
  );
  expect(requests.map(({ rpc }) => rpc)).toEqual(["prepare_factory_judge_invocation"]);
  expect(runFactoryJudge).not.toHaveBeenCalled();
});

it("preserves the database disposition when a benchmark reservation cannot authorize a call", async () => {
  const { admin, claim, requests } = fixture("benchmark_blocked", "artifact", {});

  await expect(runClaimedFactoryJudge(admin, claim, "workerd")).resolves.toBe(false);
  expect(requests.map(({ rpc }) => rpc)).toEqual([
    "prepare_factory_judge_invocation",
    "begin_factory_judge_invocation",
  ]);
  expect(runFactoryJudge).not.toHaveBeenCalled();
});

it("issues an exact one-shot permit before invoking the judge and records a typed candidate", async () => {
  const { admin, claim, requests, definition } = fixture();
  const candidate = {
    schemaVersion: 1,
    evidence: [{ kind: "artifact", id: artifactId }],
    status: "pass",
    score: { kind: "boolean", value: true },
  } as const;
  const explanation = "The relevant change was verified.";
  const locations = [{ reference: candidate.evidence[0], location: { kind: "whole" } }] as const;
  vi.mocked(runFactoryJudge).mockResolvedValue({
    result: candidate,
    explanation,
    locations: [...locations],
    judge: {
      model: "vendor/model",
      provider: "Vendor",
      requestId: "synthetic-request",
      usage: { inputTokens: 19, outputTokens: 8, costUsd: 0 },
    },
  });
  await expect(runClaimedFactoryJudge(admin, claim, "node")).resolves.toBe(true);
  expect(requests.map(({ rpc }) => rpc)).toEqual([
    "prepare_factory_judge_invocation",
    "begin_factory_judge_invocation",
    "finish_factory_judge_invocation",
  ]);
  expect(requests[1]?.body).toMatchObject({
    p_attempt_id: claim.attempt_id,
    p_lease_id: claim.lease_id,
    p_profile_revision_id: profileId,
    p_worker_runtime: "node",
    p_evidence_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(runFactoryJudge).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      definition,
      apiKey: exampleKey,
      evidence: [
        {
          mediaType: "text/plain",
          reference: { id: artifactId, kind: "artifact" },
          text: "Result summary",
        },
      ],
    }),
  );
  expect(requests[2]?.body).toMatchObject({
    p_status: "completed",
    p_candidate_result: candidate,
    p_provider_model: "vendor/model",
    p_provider_request_id: "synthetic-request",
    p_explanation: explanation,
    p_evidence_locations: locations,
    p_input_tokens: 19,
    p_output_tokens: 8,
    p_token_provenance: "measured",
    p_cost_usd: 0,
    p_cost_provenance: "measured",
  });
  expect(JSON.stringify(requests)).not.toContain("Result summary");
  expect(JSON.stringify(requests)).not.toContain(exampleKey);
});

it.each([
  { usage: { inputTokens: 19, costUsd: 0.0003 }, costUsd: 0.0003 },
  { usage: { inputTokens: 19 } },
  {
    usage: {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      costUsd: Number.MAX_SAFE_INTEGER,
    },
  },
])(
  "records known cost independently of incomplete token telemetry on invalid output %#",
  async ({ usage, costUsd }) => {
    const { admin, claim, requests } = fixture();
    vi.mocked(runFactoryJudge).mockResolvedValue({
      result: {
        schemaVersion: 1,
        evidence: [{ kind: "artifact", id: artifactId }],
        status: "error",
        reason: "invalid_output",
      },
      judge: { model: "vendor/model", usage },
    });
    await expect(runClaimedFactoryJudge(admin, claim, "node")).resolves.toBe(true);
    const result = requests.at(-1)?.body;
    expect(result).toMatchObject({ p_status: "invalid_output" });
    expect(result).not.toHaveProperty("p_input_tokens");
    expect(result).not.toHaveProperty("p_output_tokens");
    expect(result).not.toHaveProperty("p_token_provenance");
    if (costUsd !== undefined) {
      expect(result).toMatchObject({ p_cost_usd: costUsd, p_cost_provenance: "measured" });
    } else {
      expect(result).not.toHaveProperty("p_cost_usd");
      expect(result).not.toHaveProperty("p_cost_provenance");
    }
  },
);

it("records evidence withholding discovered after preparation without sending it", async () => {
  const { admin, claim, requests } = fixture("missing_evidence");
  await expect(runClaimedFactoryJudge(admin, claim, "workerd")).resolves.toBe(true);
  expect(runFactoryJudge).not.toHaveBeenCalled();
  expect(requests.at(-1)?.body).toMatchObject({ p_status: "missing_evidence" });
});

it("leaves a duplicate permit to its original caller", async () => {
  const { admin, claim, requests } = fixture("already_started");
  await expect(runClaimedFactoryJudge(admin, claim, "workerd")).resolves.toBe(false);
  expect(runFactoryJudge).not.toHaveBeenCalled();
  expect(requests).toHaveLength(2);
});

it("retries a temporary private-evidence outage before requesting a permit", async () => {
  const { admin, claim, requests } = fixture("authorized", "validation_report");
  await expect(runClaimedFactoryJudge(admin, claim, "node")).resolves.toBe(true);
  expect(runFactoryJudge).not.toHaveBeenCalled();
  expect(requests.map(({ rpc }) => rpc)).toEqual([
    "prepare_factory_judge_invocation",
    "finish_factory_judge_invocation",
  ]);
  expect(requests.at(-1)?.body).toMatchObject({ p_status: "evidence_unavailable" });
});
