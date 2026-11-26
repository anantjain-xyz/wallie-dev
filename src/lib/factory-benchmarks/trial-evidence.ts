import "server-only";

import { createHash } from "node:crypto";

import {
  loadScopedRunTranscript,
  RunTranscriptReadError,
  RunTranscriptResetError,
} from "@/features/wallie/run-transcript";
import type { RunTranscriptQuery } from "@/features/wallie/run-transcript-contracts";
import { redactRunSensitiveText } from "@/lib/agent-runner/redact-sensitive-text";
import {
  BROWSER_VIDEO_ASSET_FIELDS,
  readPrivateBrowserScreenshot,
  readPrivateBrowserVideo,
} from "@/lib/validation-evidence/browser-assets";
import { projectBrowserEvidenceReceipt } from "@/lib/validation-evidence/browser-evidence-view";

import { BenchmarkComparisonError, type BenchmarkComparisonScope } from "./comparison";
import {
  benchmarkTrialEvidenceSchema,
  type BenchmarkTrialEvidence,
  type BenchmarkTrialEvidenceOwner,
  type TrialEvidenceMediaSide,
} from "./trial-evidence-contracts";

export type BenchmarkTrialEvidenceScope = BenchmarkComparisonScope & { trialId: string };

export async function readBenchmarkTrialEvidence(
  scope: BenchmarkTrialEvidenceScope,
): Promise<BenchmarkTrialEvidence> {
  scope.signal?.throwIfAborted();
  const request = scope.admin.rpc("read_factory_benchmark_trial_evidence", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_experiment_id: scope.experimentId,
    p_trial_id: scope.trialId,
    p_actor_user_id: scope.actorUserId,
  });
  const { data, error } = await (scope.signal ? request.abortSignal(scope.signal) : request);
  scope.signal?.throwIfAborted();
  if (error?.code === "42501") {
    throw new BenchmarkComparisonError(403, "Factory manager access is required.");
  }
  if (error?.code === "P0002" || (!error && data === null)) {
    throw new BenchmarkComparisonError(404, "The benchmark trial is unavailable.");
  }
  if (error) throw new Error("The benchmark trial evidence could not be read.");

  const evidence = benchmarkTrialEvidenceSchema.parse(data);
  if (
    evidence.workspaceId !== scope.workspaceId ||
    evidence.factoryId !== scope.factoryId ||
    evidence.experimentId !== scope.experimentId ||
    evidence.trial.id !== scope.trialId
  )
    throw new Error("The benchmark evidence scope did not match the request.");

  if (evidence.diff.patch !== null) {
    const patch = evidence.diff.patch;
    if (
      evidence.diff.availability !== "available" ||
      Buffer.byteLength(patch, "utf8") > 65_536 ||
      createHash("sha256").update(patch).digest("hex") !== evidence.diff.sha256 ||
      redactRunSensitiveText(patch) !== patch
    )
      evidence.diff = { availability: "unavailable", patch: null, sha256: null };
  }
  evidence.scores = evidence.scores.map((score) => ({
    ...score,
    explanation: score.explanation === null ? null : redactRunSensitiveText(score.explanation),
  }));
  return evidence;
}

export function readBenchmarkTrialTranscript(
  scope: BenchmarkTrialEvidenceScope,
  query?: RunTranscriptQuery,
) {
  return readTrialTranscript(scope, () => readBenchmarkTrialEvidence(scope), query);
}

function readTrialTranscript(
  scope: BenchmarkTrialEvidenceScope,
  readEvidence: () => Promise<BenchmarkTrialEvidence>,
  query?: RunTranscriptQuery,
) {
  return loadScopedRunTranscript({
    supabase: scope.admin,
    workspaceId: scope.workspaceId,
    query,
    signal: scope.signal,
    async readOwner() {
      const { output, trial } = await readEvidence();
      if (!trial.started || output.availability === "withheld" || !output.owner) return null;
      return {
        run_id: output.owner.runId,
        attempt_count: output.owner.attemptCount,
        status: output.owner.runStatus,
        transcript_expired_at: output.transcriptExpiredAt,
      };
    },
  });
}

export async function readBenchmarkTrialPageEvidence(
  scope: BenchmarkTrialEvidenceScope,
  suiteId: string,
) {
  async function read() {
    const detail = await readBenchmarkTrialEvidence(scope);
    if (detail.suite.id !== suiteId)
      throw new BenchmarkComparisonError(404, "The benchmark trial is unavailable.");
    return detail;
  }

  let detail = await read();
  let initial = true;
  try {
    const transcript = await readTrialTranscript(scope, async () => {
      if (!initial) detail = await read();
      initial = false;
      return detail;
    });
    if (
      !transcript &&
      detail.trial.started &&
      detail.output.availability !== "withheld" &&
      detail.output.owner
    )
      detail = await read();
    return { detail, transcript };
  } catch (error) {
    if (!(error instanceof RunTranscriptReadError || error instanceof RunTranscriptResetError))
      throw error;
    return {
      detail,
      transcript:
        detail.output.availability !== "withheld" && detail.output.owner
          ? ("retry" as const)
          : null,
    };
  }
}

function mediaOwner(trial: BenchmarkTrialEvidence, side: TrialEvidenceMediaSide) {
  const evidence = side === "original" ? trial.source : trial.output;
  const { owner } = evidence;
  if (
    evidence.availability !== "available" ||
    !evidence.mediaPlanMatched ||
    !owner?.commitSha ||
    !owner.treeSha
  )
    return null;
  return { ...owner, commitSha: owner.commitSha, treeSha: owner.treeSha };
}

function sameMediaOwner(
  current: BenchmarkTrialEvidenceOwner | null,
  expected: BenchmarkTrialEvidenceOwner,
) {
  return (
    current?.runId === expected.runId &&
    current.sessionId === expected.sessionId &&
    current.jobId === expected.jobId &&
    current.attemptCount === expected.attemptCount &&
    current.commitSha === expected.commitSha &&
    current.treeSha === expected.treeSha
  );
}

async function readExactTrialMedia(
  scope: BenchmarkTrialEvidenceScope,
  side: TrialEvidenceMediaSide,
) {
  const owner = mediaOwner(await readBenchmarkTrialEvidence(scope), side);
  if (!owner) return null;

  const request = scope.admin
    .from("session_browser_verification_receipts")
    .select(
      "workspace_id, session_id, run_id, records, created_at, plan:session_validation_plans!inner(job_id, attempt_count, commit_sha, validation_tree_sha, browser_plan:plan->browser)",
    )
    .eq("workspace_id", scope.workspaceId)
    .eq("session_id", owner.sessionId)
    .eq("run_id", owner.runId)
    .eq("plan.workspace_id", scope.workspaceId)
    .eq("plan.session_id", owner.sessionId)
    .eq("plan.job_id", owner.jobId)
    .eq("plan.attempt_count", owner.attemptCount)
    .eq("plan.commit_sha", owner.commitSha)
    .eq("plan.validation_tree_sha", owner.treeSha);
  const { data, error } = await (
    scope.signal ? request.abortSignal(scope.signal) : request
  ).maybeSingle();
  if (error) throw new Error("The exact browser evidence could not be read.");
  if (
    !data?.plan ||
    data.workspace_id !== scope.workspaceId ||
    data.session_id !== owner.sessionId ||
    data.run_id !== owner.runId ||
    data.plan.job_id !== owner.jobId ||
    data.plan.attempt_count !== owner.attemptCount ||
    data.plan.commit_sha !== owner.commitSha ||
    data.plan.validation_tree_sha !== owner.treeSha
  )
    return null;
  const receipt = projectBrowserEvidenceReceipt(data, { requireMatchedPlan: true });
  return receipt ? { owner, receipt } : null;
}

export async function readBenchmarkTrialMedia(
  scope: BenchmarkTrialEvidenceScope,
  side: TrialEvidenceMediaSide,
) {
  const match = await readExactTrialMedia(scope, side);
  if (!match) return { browserEvidence: [] };

  const assetIds = match.receipt.records.flatMap((record) =>
    record.status === "captured" ? [record.manifest.assetId] : [],
  );
  if (!assetIds.length) {
    const current = mediaOwner(await readBenchmarkTrialEvidence(scope), side);
    return { browserEvidence: sameMediaOwner(current, match.owner) ? [match.receipt] : [] };
  }
  const request = scope.admin
    .from("session_browser_asset_withholdings")
    .select("asset_id")
    .in("asset_id", assetIds);
  const { data, error } = await (scope.signal ? request.abortSignal(scope.signal) : request);
  if (error) throw new Error("Browser evidence availability could not be checked.");
  const current = mediaOwner(await readBenchmarkTrialEvidence(scope), side);
  if (!sameMediaOwner(current, match.owner)) return { browserEvidence: [] };
  const withheld = new Set(data.map(({ asset_id }) => asset_id));
  if (!withheld.size) return { browserEvidence: [match.receipt] };
  const { records, videoFindings, ...identity } = match.receipt;
  const visibleFindings = videoFindings?.filter(({ assetId }) => !withheld.has(assetId));
  return {
    browserEvidence: [
      {
        ...identity,
        records: records.map((record) => {
          if (record.status !== "captured" || !withheld.has(record.manifest.assetId)) return record;
          const { kind, key, path, policy } = record;
          return {
            kind,
            key,
            path,
            policy,
            status: "unavailable" as const,
            reason: "policy_excluded" as const,
          };
        }),
        ...(visibleFindings?.length ? { videoFindings: visibleFindings } : {}),
      },
    ],
  };
}

export async function readBenchmarkTrialMediaAsset(
  scope: BenchmarkTrialEvidenceScope,
  side: TrialEvidenceMediaSide,
  assetId: string,
) {
  const matched = await readExactTrialMedia(scope, side);
  const captures = matched?.receipt.records.filter(
    (record) => record.status === "captured" && record.manifest.assetId === assetId,
  );
  const captured = captures?.length === 1 ? captures[0] : null;
  if (!matched || !captured || captured.status !== "captured") return null;
  const { owner } = matched;
  const request = scope.admin
    .from("session_browser_verification_assets")
    .select(`${BROWSER_VIDEO_ASSET_FIELDS}, evidence_key, browser_session_id`)
    .eq("workspace_id", scope.workspaceId)
    .eq("session_id", owner.sessionId)
    .eq("run_id", owner.runId)
    .eq("id", assetId);
  const { data: asset, error } = await (
    scope.signal ? request.abortSignal(scope.signal) : request
  ).maybeSingle();
  if (error) throw new Error("The exact browser recording could not be read.");
  const { manifest } = captured;
  if (
    !asset ||
    asset.evidence_key !== "browser:" + captured.kind + ":" + captured.key ||
    asset.browser_session_id !== captured.browserSessionId ||
    asset.sha256 !== manifest.sha256 ||
    asset.content_type !== manifest.contentType ||
    asset.size_bytes !== manifest.sizeBytes
  )
    return null;

  const read = captured.kind === "video" ? readPrivateBrowserVideo : readPrivateBrowserScreenshot;
  const result = await read({
    supabase: scope.admin,
    workspaceId: scope.workspaceId,
    sessionId: owner.sessionId,
    runId: owner.runId,
    asset,
    signal: scope.signal,
  });
  const latest = await readExactTrialMedia(scope, side);
  if (
    !latest ||
    !sameMediaOwner(latest.owner, owner) ||
    !latest.receipt.records.some(
      (record) =>
        record.status === "captured" &&
        record.manifest.assetId === assetId &&
        record.manifest.sha256 === manifest.sha256,
    )
  )
    return null;
  return { result, kind: captured.kind, contentType: manifest.contentType };
}
