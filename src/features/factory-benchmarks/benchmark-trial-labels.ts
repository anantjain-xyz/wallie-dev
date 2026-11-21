import type { StatusValue } from "@/components/ui/status";
import type { BenchmarkComparisonTrial } from "@/lib/factory-benchmarks/comparison-contracts";

export const benchmarkHarnessNames: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};
export const benchmarkRuntimeNames: Record<string, string> = {
  node: "Node.js",
  workerd: "Cloudflare Workers",
};
export const benchmarkTrialStatuses = {
  excluded: { label: "Excluded", value: "skipped" },
  pending: { label: "Pending", value: "queued" },
  running: { label: "Running", value: "running" },
  succeeded: { label: "Completed", value: "complete" },
  failed: { label: "Failed", value: "failed" },
  timed_out: { label: "Timed out", value: "failed" },
  canceled: { label: "Canceled", value: "canceled" },
  unavailable: { label: "Unavailable", value: "blocked" },
} satisfies Record<BenchmarkComparisonTrial["status"], { label: string; value: StatusValue }>;
export function benchmarkReasonLabel(reason: string) {
  return /^[a-z][a-z_]+$/.test(reason)
    ? reason.charAt(0).toUpperCase() + reason.slice(1).replaceAll("_", " ")
    : reason;
}

export function benchmarkCandidateRole(position: number | null) {
  if (position === null) return null;
  return position === 1 ? "Baseline" : `Candidate ${position - 1}`;
}
