import "server-only";

import { z } from "zod";

import type { BrowserRecordingFindings } from "@/features/wallie/browser-evidence-contracts";
import {
  browserCaptureReceiptSchema,
  browserVerificationPlanSchema,
} from "@/lib/validation-evidence/browser-contract";

type BrowserEvidenceRow = {
  run_id: string;
  created_at: string;
  records: unknown;
  plan: {
    attempt_count: number;
    commit_sha: string;
    validation_tree_sha: string;
    browser_plan: unknown;
  } | null;
};

export function projectBrowserEvidenceReceipt(
  { records, plan, run_id, created_at }: BrowserEvidenceRow,
  options: {
    expectedCommitSha?: string;
    screenshotUrl?: (assetId: string) => string;
    requireMatchedPlan?: boolean;
  } = {},
) {
  const parsed = z.array(browserCaptureReceiptSchema).max(10).safeParse(records);
  if (!parsed.success || !plan) return null;

  const browserPlan = browserVerificationPlanSchema.safeParse(plan.browser_plan);
  const videoFindings: BrowserRecordingFindings[] = [];
  const scopedRecords = parsed.data.map((record) => {
    if (record.status !== "captured") return record;
    const { key, kind, path, policy } = record;
    if (options.expectedCommitSha && plan.commit_sha !== options.expectedCommitSha) {
      return { key, kind, path, policy, status: "failed", reason: "source_changed" } as const;
    }
    const check = browserPlan.data?.find((item) => item.key === key && item.path === path);
    if (options.requireMatchedPlan && !check?.evidence.some((item) => item.kind === kind)) {
      return { key, kind, path, policy, status: "failed", reason: "source_changed" } as const;
    }
    if (kind === "video") {
      const [entry, ...offsets] = record.manifest.frameOffsetsMs;
      if (
        entry !== 0 ||
        !check?.evidence.some((item) => item.kind === "video") ||
        offsets.length !== check.interactions.length ||
        record.manifest.durationMs > check.timeoutSeconds * 1000 ||
        Date.parse(record.completedAt) < Date.parse(record.startedAt)
      ) {
        return { key, kind, path, policy, status: "failed", reason: "capture_failed" } as const;
      }
      videoFindings.push({
        assetId: record.manifest.assetId,
        steps: [
          { action: "entry", offsetMs: entry },
          ...check.interactions.map((action, index) => ({ ...action, offsetMs: offsets[index]! })),
        ],
      });
      return record;
    }
    return options.screenshotUrl
      ? { ...record, downloadUrl: options.screenshotUrl(record.manifest.assetId) }
      : record;
  });
  return {
    runId: run_id,
    attemptCount: plan.attempt_count,
    commitSha: plan.commit_sha,
    treeSha: plan.validation_tree_sha,
    createdAt: created_at,
    records: scopedRecords,
    ...(videoFindings.length ? { videoFindings } : {}),
  };
}
