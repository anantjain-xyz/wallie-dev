import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readBenchmarkTrialCitation } from "./trial-citation";
import {
  readBenchmarkTrialEvidence,
  readBenchmarkTrialMedia,
  readBenchmarkTrialMediaAsset,
  readBenchmarkTrialPageEvidence,
  type BenchmarkTrialEvidenceScope,
} from "./trial-evidence";
import type { BenchmarkTrialEvidence } from "./trial-evidence-contracts";

const { readScreenshot, readVideo } = vi.hoisted(() => ({
  readScreenshot: vi.fn(),
  readVideo: vi.fn(),
}));

vi.mock("@/lib/validation-evidence/browser-assets", async (load) => ({
  ...(await load<typeof import("@/lib/validation-evidence/browser-assets")>()),
  readPrivateBrowserScreenshot: readScreenshot,
  readPrivateBrowserVideo: readVideo,
}));

const uuid = (value: number) => "62200000-0000-4000-8000-" + String(value).padStart(12, "0");
const sha = "a".repeat(40);
const tree = "b".repeat(40);
const digest = "c".repeat(64);
const assetId = uuid(11);
const browserSessionId = uuid(12);
const scorerRevisionId = uuid(17);
const citationQuery = { scorerRevisionId, resultDigest: digest, index: 0 };
const validationText = `{"key": "replay", "status": "passed", "treeSha": "${tree}", "commitSha": "${sha}"}`;
const artifact = "First line\nCited line\nAnother private line";

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function evidence(): BenchmarkTrialEvidence {
  const noMedia = {
    availability: "unavailable" as const,
    owner: null,
    mediaPlanMatched: false,
    transcriptExpiredAt: null,
  };
  return {
    workspaceId: uuid(1),
    factoryId: uuid(2),
    experimentId: uuid(3),
    suite: { id: uuid(4), revisionId: uuid(5), revisionNumber: 1, name: "Fixture suite" },
    trial: {
      id: uuid(6),
      repetition: 1,
      seed: 0,
      timeoutMs: 60_000,
      eligibility: "eligible",
      eligibilityReason: null,
      status: "succeeded",
      reason: null,
      admitted: true,
      started: true,
    },
    task: {
      id: uuid(7),
      revisionId: uuid(8),
      revisionNumber: 1,
      name: "Fixture task",
      acceptanceCriteria: "Keep the exact fixture.",
      acceptanceTruncated: false,
      tags: [],
    },
    candidate: {
      key: digest,
      position: 1,
      definitionRevisionId: uuid(9),
      definitionDigest: digest,
      harness: "codex",
      model: "fixture",
      workerRuntime: "workerd",
      sandboxProvider: "vercel",
    },
    frozenInputs: {
      policyRevisionId: uuid(10),
      policyDigest: digest,
      checkoutSha: sha,
      inputSha: sha,
      sourceDefinitionRevisionId: null,
      sourceDefinitionDigest: null,
      contextManifestSha256: null,
    },
    source: noMedia,
    output: {
      ...noMedia,
      availability: "available",
      owner: {
        sessionId: uuid(13),
        runId: uuid(14),
        jobId: uuid(15),
        attemptCount: 1,
        runStatus: "success",
        commitSha: sha,
        treeSha: tree,
      },
      mediaPlanMatched: true,
      inputCommitSha: sha,
      inputTreeSha: tree,
      resultDigest: digest,
      validation: null,
    },
    diff: { availability: "unavailable", patch: null, sha256: null },
    scores: [],
  };
}

type DatabaseResponse = { data: unknown; error: { code: string } | null };
function query(response: DatabaseResponse) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    abortSignal: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(response),
    then(resolve: (value: DatabaseResponse) => unknown) {
      return Promise.resolve(response).then(resolve);
    },
  };
}

function fixture(
  options: {
    denyAfter?: number;
    wrongTree?: boolean;
    wrongKey?: boolean;
    eventFailure?: boolean;
    secondDetail?: (detail: BenchmarkTrialEvidence) => BenchmarkTrialEvidence;
    artifactText?: string;
    artifactDigest?: string;
  } = {},
) {
  const detail = evidence();
  const png = {
    key: "preview",
    path: "/fixture",
    kind: "screenshot",
    status: "captured",
    policy: "isolated-fixture-v1",
    browserSessionId,
    manifest: { assetId, sha256: digest, contentType: "image/png", sizeBytes: 32 },
  };
  const receipt = {
    workspace_id: uuid(1),
    session_id: uuid(13),
    run_id: uuid(14),
    created_at: "2026-11-21T17:15:00+00:00",
    records: [png],
    plan: {
      job_id: uuid(15),
      attempt_count: 1,
      commit_sha: sha,
      validation_tree_sha: options.wrongTree ? sha : tree,
      browser_plan: [
        {
          key: "preview",
          path: "/fixture",
          timeoutSeconds: 2,
          interactions: [],
          regionTestId: "preview",
          excludedTestIds: [],
          evidence: [{ kind: "screenshot", required: true }],
        },
      ],
    },
  };
  const queries = {
    agent_run_events: query({
      data: options.eventFailure ? null : [],
      error: options.eventFailure ? { code: "synthetic_timeout" } : null,
    }),
    factory_benchmark_trial_results: query({
      data: {
        artifact_markdown: options.artifactText ?? artifact,
        artifact_sha256: options.artifactDigest ?? hash(options.artifactText ?? artifact),
        validation_text: validationText,
      },
      error: null,
    }),
    session_browser_verification_receipts: query({ data: receipt, error: null }),
    session_browser_verification_assets: query({
      data: {
        id: assetId,
        evidence_key: options.wrongKey ? "browser:screenshot:other" : "browser:screenshot:preview",
        browser_session_id: browserSessionId,
        sha256: digest,
        content_type: "image/png",
        size_bytes: 32,
      },
      error: null,
    }),
    session_browser_asset_withholdings: query({ data: [], error: null }),
  };
  let reads = 0;
  const admin = {
    rpc: vi.fn(() => {
      const denied = ++reads > (options.denyAfter ?? Number.POSITIVE_INFINITY);
      return query({
        data: denied ? null : reads > 1 ? (options.secondDetail?.(detail) ?? detail) : detail,
        error: denied ? { code: "42501" } : null,
      });
    }),
    from: vi.fn((table: keyof typeof queries) => queries[table]),
  };
  const scope: BenchmarkTrialEvidenceScope = {
    admin: admin as unknown as BenchmarkTrialEvidenceScope["admin"],
    workspaceId: uuid(1),
    factoryId: uuid(2),
    experimentId: uuid(3),
    trialId: uuid(6),
    actorUserId: uuid(16),
  };
  return { scope, admin, queries, detail };
}

function addScore(detail: BenchmarkTrialEvidence) {
  detail.scores.push({
    scorerRevisionId,
    scorerId: uuid(18),
    name: "Fixture scorer",
    revisionNumber: 1,
    status: "pass",
    reason: null,
    score: { kind: "boolean", value: true },
    explanation: "The evidence supports the score.",
    evidenceAvailability: "available",
    evidenceLocations: [
      { kind: "artifact", location: { kind: "lines", startLine: 2, endLine: 2 } },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readScreenshot.mockResolvedValue({ status: "available", bytes: new Uint8Array([1, 2, 3]) });
});

describe("benchmark trial page transcript isolation", () => {
  it("keeps the authorized diff and scores when the events query fails", async () => {
    const { scope, detail, admin } = fixture({ eventFailure: true });
    const patch = "+approved change";
    detail.diff = { availability: "available", patch, sha256: hash(patch) };
    addScore(detail);
    await expect(readBenchmarkTrialPageEvidence(scope, detail.suite.id)).resolves.toMatchObject({
      detail: { diff: { patch }, scores: [{ status: "pass" }] },
      transcript: "retry",
    });
    expect(admin.rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps a settlement reset local and returns the rechecked trial evidence", async () => {
    const { scope, detail } = fixture({
      secondDetail: (detail) => ({
        ...detail,
        trial: { ...detail.trial, status: "failed" },
        output: { ...detail.output, owner: { ...detail.output.owner!, runStatus: "error" } },
      }),
    });
    detail.trial.status = "running";
    detail.output.owner!.runStatus = "running";
    await expect(readBenchmarkTrialPageEvidence(scope, detail.suite.id)).resolves.toMatchObject({
      detail: { trial: { status: "failed" } },
      transcript: "retry",
    });
  });

  it.each([false, true])(
    "fails closed when access is revoked during a read (event error: %s)",
    async (eventFailure) => {
      const { scope, detail } = fixture({ eventFailure, denyAfter: 1 });
      await expect(readBenchmarkTrialPageEvidence(scope, detail.suite.id)).rejects.toMatchObject({
        status: 403,
      });
    },
  );

  it("never queries events for a trial outside the route suite", async () => {
    const { scope, admin } = fixture();
    await expect(readBenchmarkTrialPageEvidence(scope, uuid(19))).rejects.toMatchObject({
      status: 404,
    });
    expect(admin.from).not.toHaveBeenCalled();
  });
});

describe("benchmark trial citations", () => {
  it("returns only the inclusive passage from the retained artifact", async () => {
    const { scope, detail, queries } = fixture();
    addScore(detail);
    await expect(readBenchmarkTrialCitation(scope, citationQuery)).resolves.toEqual({
      passage: "Cited line",
    });
    const result = queries.factory_benchmark_trial_results;
    expect(result.eq).toHaveBeenCalledWith("run_id", uuid(14));
    expect(result.eq).toHaveBeenCalledWith("output_tree_sha", tree);
    expect(result.eq).toHaveBeenCalledWith("result_digest", digest);
  });

  it("preserves the validation text representation used by the judge", async () => {
    const { scope, detail } = fixture();
    addScore(detail);
    detail.output.validation = { key: "replay", status: "passed", commitSha: sha, treeSha: tree };
    detail.scores[0].evidenceLocations = [
      { kind: "validation_report", location: { kind: "whole" } },
    ];
    await expect(readBenchmarkTrialCitation(scope, citationQuery)).resolves.toEqual({
      passage: validationText,
    });
  });

  it.each([
    { artifactDigest: "d".repeat(64) },
    { artifactText: "API_KEY=synthetic-private-key\nCited line" },
    { artifactText: "First line only" },
  ])("withholds an inexact, unsafe or out-of-bounds source (%j)", async (options) => {
    const { scope, detail } = fixture(options);
    addScore(detail);
    await expect(readBenchmarkTrialCitation(scope, citationQuery)).resolves.toBeNull();
  });

  it("does not query source content for an unpinned or withheld citation", async () => {
    const { scope, detail, admin } = fixture();
    addScore(detail);
    await expect(
      readBenchmarkTrialCitation(scope, { ...citationQuery, resultDigest: "d".repeat(64) }),
    ).resolves.toBeNull();
    detail.scores[0].evidenceAvailability = "withheld";
    await expect(readBenchmarkTrialCitation(scope, citationQuery)).resolves.toBeNull();
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("checks current manager access again before delivering the passage", async () => {
    const { scope, detail } = fixture({ denyAfter: 1 });
    addScore(detail);
    await expect(readBenchmarkTrialCitation(scope, citationQuery)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("exact benchmark trial evidence", () => {
  it("denies detail when the requester loses factory access", async () => {
    const { scope, admin } = fixture({ denyAfter: 0 });
    await expect(readBenchmarkTrialEvidence(scope)).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("requires a receipt for the selected side, plan tree, and canonical asset key", async () => {
    const wrongTree = fixture({ wrongTree: true });
    await expect(readBenchmarkTrialMedia(wrongTree.scope, "output")).resolves.toEqual({
      browserEvidence: [],
    });
    const wrongKey = fixture({ wrongKey: true });
    await expect(
      readBenchmarkTrialMediaAsset(wrongKey.scope, "output", assetId),
    ).resolves.toBeNull();
    const correct = fixture();
    await expect(
      readBenchmarkTrialMediaAsset(correct.scope, "original", assetId),
    ).resolves.toBeNull();
    expect(readScreenshot).not.toHaveBeenCalled();
    await expect(
      readBenchmarkTrialMediaAsset(correct.scope, "output", assetId),
    ).resolves.toMatchObject({
      kind: "screenshot",
      result: { status: "available" },
    });
    expect(correct.queries.session_browser_verification_receipts.eq).toHaveBeenCalledWith(
      "plan.job_id",
      uuid(15),
    );
    expect(readScreenshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: uuid(13), runId: uuid(14) }),
    );
  });

  it("rechecks current access after receipt metadata and after reading private bytes", async () => {
    const revokedMetadata = fixture({ denyAfter: 1 });
    await expect(readBenchmarkTrialMedia(revokedMetadata.scope, "output")).rejects.toMatchObject({
      status: 403,
    });
    expect(readScreenshot).not.toHaveBeenCalled();
    const revokedBytes = fixture({ denyAfter: 1 });
    await expect(
      readBenchmarkTrialMediaAsset(revokedBytes.scope, "output", assetId),
    ).rejects.toMatchObject({ status: 403 });
    expect(readScreenshot).toHaveBeenCalledTimes(1);
  });

  it("returns the exact reader's expired disposition without a usable body", async () => {
    const { scope } = fixture();
    readScreenshot.mockResolvedValueOnce({ status: "withheld", availability: "expired" });
    await expect(readBenchmarkTrialMediaAsset(scope, "output", assetId)).resolves.toMatchObject({
      result: { status: "withheld", availability: "expired" },
    });
  });
});
