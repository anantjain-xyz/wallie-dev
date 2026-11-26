import "server-only";

import { createHash } from "node:crypto";

import { redactRunSensitiveText } from "@/lib/agent-runner/redact-sensitive-text";
import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";
import { MAX_FACTORY_JUDGE_TEXT_BYTES } from "@/lib/factory-evaluations/judge-contracts";

import { readBenchmarkTrialEvidence, type BenchmarkTrialEvidenceScope } from "./trial-evidence";
import type {
  BenchmarkTrialEvidence,
  TrialEvidenceCitationQuery,
} from "./trial-evidence-contracts";

function matchingCitation(detail: BenchmarkTrialEvidence, query: TrialEvidenceCitationQuery) {
  if (
    detail.output.availability !== "available" ||
    detail.output.resultDigest !== query.resultDigest
  )
    return null;
  const score = detail.scores.find((score) => score.scorerRevisionId === query.scorerRevisionId);
  if (score?.evidenceAvailability !== "available") return null;
  return score.evidenceLocations[query.index] ?? null;
}

export async function readBenchmarkTrialCitation(
  scope: BenchmarkTrialEvidenceScope,
  query: TrialEvidenceCitationQuery,
) {
  const detail = await readBenchmarkTrialEvidence(scope);
  const citation = matchingCitation(detail, query);
  const { owner, validation, inputCommitSha, inputTreeSha } = detail.output;
  if (!citation || !owner?.commitSha || !owner.treeSha || !inputCommitSha || !inputTreeSha)
    return null;

  const request = scope.admin
    .from("factory_benchmark_trial_results")
    .select("artifact_markdown, artifact_sha256, validation_text:validation::text")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .eq("trial_id", scope.trialId)
    .eq("run_id", owner.runId)
    .eq("result_digest", query.resultDigest)
    .eq("output_commit_sha", owner.commitSha)
    .eq("output_tree_sha", owner.treeSha)
    .eq("input_commit_sha", inputCommitSha)
    .eq("input_tree_sha", inputTreeSha);
  const { data, error } = await (
    scope.signal ? request.abortSignal(scope.signal) : request
  ).maybeSingle();
  if (error) throw new Error("The benchmark citation could not be read.");
  if (!data) return null;

  const text = citation.kind === "artifact" ? data.artifact_markdown : data.validation_text;
  if (
    typeof text !== "string" ||
    !text.length ||
    Buffer.byteLength(text, "utf8") > MAX_FACTORY_JUDGE_TEXT_BYTES ||
    !isFactoryDefinitionText(text) ||
    redactRunSensitiveText(text) !== text
  )
    return null;

  if (citation.kind === "artifact") {
    if (createHash("sha256").update(text).digest("hex") !== data.artifact_sha256) return null;
  } else if (
    !validation ||
    validation.commitSha !== owner.commitSha ||
    validation.treeSha !== owner.treeSha
  ) {
    return null;
  }

  const { location } = citation;
  let passage = text;
  if (location.kind === "lines") {
    const lines = text.split("\n");
    if (location.endLine < location.startLine || location.endLine > lines.length) return null;
    passage = lines.slice(location.startLine - 1, location.endLine).join("\n");
  }

  const latest = await readBenchmarkTrialEvidence(scope);
  const current = matchingCitation(latest, query);
  if (
    !current ||
    JSON.stringify(current) !== JSON.stringify(citation) ||
    latest.output.owner?.runId !== owner.runId ||
    latest.output.owner.sessionId !== owner.sessionId ||
    latest.output.owner.jobId !== owner.jobId ||
    latest.output.owner.attemptCount !== owner.attemptCount ||
    latest.output.owner.commitSha !== owner.commitSha ||
    latest.output.owner.treeSha !== owner.treeSha
  )
    return null;
  return { passage };
}
