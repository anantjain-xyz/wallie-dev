import { Status, type StatusValue } from "@/components/ui/status";
import type { ScoreTrendRow } from "@/lib/factory-evaluations/score-trend-contracts";

const statusLabels: Record<ScoreTrendRow["status"], { label: string; value: StatusValue }> = {
  pass: { label: "Passed", value: "approved" },
  fail: { label: "Failed", value: "failed" },
  inconclusive: { label: "Inconclusive", value: "needs_attention" },
  error: { label: "Evaluator error", value: "failed" },
  skipped: { label: "Skipped", value: "skipped" },
  excluded: { label: "Excluded", value: "skipped" },
  not_sampled: { label: "Not sampled", value: "not_started" },
  unsettled: { label: "Awaiting evaluation", value: "queued" },
};

const reasonLabels: Record<string, string> = {
  status_excluded: "Run status outside the sampling policy",
  stage_excluded: "Stage outside the sampling policy",
  unsupported_run: "No accepted checkpoint for this run",
  missing_evidence: "Missing evidence",
  withheld_evidence: "Evidence withheld",
  unsupported_evidence: "Unsupported evidence",
  evidence_unavailable: "Evidence unavailable",
  profile_unavailable: "Judge profile unavailable",
  between_thresholds: "Between pass and fail thresholds",
  ambiguous_evidence: "Ambiguous evidence",
  invalid_output: "Invalid judge output",
  provider_unavailable: "Judge provider unavailable",
  timeout: "Judge timed out",
  judgment_unavailable: "Judgment unavailable",
  lease_expired: "Evaluation lease expired",
  canceled: "Canceled",
  scorer_paused: "Admission paused",
};

export function scoreReason(reason: string | null): string | undefined {
  return reason ? reasonLabels[reason] : undefined;
}

const standaloneReasons = new Set([
  "missing_evidence",
  "withheld_evidence",
  "unsupported_evidence",
  "canceled",
  "scorer_paused",
]);

export function scoreReasonDetail(reason: string | null) {
  return reason && !standaloneReasons.has(reason) ? scoreReason(reason) : undefined;
}

export function ScoreOutcome({
  status,
  reason,
}: {
  status: ScoreTrendRow["status"];
  reason: string | null;
}) {
  if (
    reason === "missing_evidence" ||
    reason === "withheld_evidence" ||
    reason === "unsupported_evidence"
  ) {
    return <Status compact label={scoreReason(reason)} value="needs_attention" />;
  }
  if (reason === "canceled") return <Status compact label="Canceled" value="canceled" />;
  if (reason === "scorer_paused")
    return <Status compact label="Admission paused" value="blocked" />;
  const { label, value } = statusLabels[status];
  return <Status compact label={label} value={value} />;
}

export const scoreNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

export function scoreValue(score: ScoreTrendRow["score"]) {
  if (!score) return null;
  if (score.kind === "boolean") return score.value ? "True" : "False";
  return scoreNumber.format(score.value);
}
