// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ScoreTrend } from "@/lib/factory-evaluations/score-trend-contracts";

import { ScorerTrends } from "./scorer-trends";

const policyId = "608a0000-0000-4000-8000-000000000001";
const runId = "608a0000-0000-4000-8000-000000000002";
const revisionId = "608a0000-0000-4000-8000-000000000003";
const factoryId = "608a0000-0000-4000-8000-000000000004";
const attemptId = "608a0000-0000-4000-8000-000000000005";
const jobId = "608a0000-0000-4000-8000-000000000006";
const at = "2026-11-19T00:00:00Z";
const scoreSnapshot = `17.${"f".repeat(64)}`;
const counts = {
  candidate_count: 4,
  eligible_count: 4,
  sampled_count: 4,
  not_sampled_count: 0,
  excluded_count: 0,
  usable_count: 3,
  decided_count: 2,
  pass_count: 1,
  fail_count: 1,
  inconclusive_count: 1,
  skipped_count: 0,
  error_count: 1,
  unsettled_count: 0,
  missing_evidence_count: 0,
  withheld_evidence_count: 0,
  unsupported_evidence_count: 0,
  mean_numeric_score: 0.5,
};
const cohort = {
  scorer_name: "Release quality",
  scorer_slug: "release-quality",
  scorer_id: "608a0000-0000-4000-8000-000000000008",
  scorer_revision_id: revisionId,
  scorer_revision_number: 2,
  policy_id: policyId,
  policy_revision_number: 1,
  rate_bps: 10000,
  terminal_statuses: ["success"],
  stage_ids: [],
  created_at: at,
} satisfies ScoreTrend["cohort"];

describe("scorer trends", () => {
  it("offers matching chart and table drilldowns and opens the exact frozen attempt", () => {
    render(
      <ScorerTrends
        data={{
          cohorts: [cohort],
          policyId,
          requestedRevision: revisionId,
          trend: {
            cohort,
            from: at,
            to: "2026-11-20T00:00:00Z",
            snapshot: scoreSnapshot,
            totals: counts,
            row_count: 1,
            next_run_finished_at: null,
            next_run_id: null,
            points: [{ ...counts, bucket_at: at }],
            rows: [
              {
                sample_receipt_id: "608a0000-0000-4000-8000-000000000009",
                run_id: runId,
                session_id: "608a0000-0000-4000-8000-000000000010",
                run_finished_at: at,
                target_commit_sha: "a".repeat(40),
                sample_outcome: "sampled",
                sample_reason: null,
                evaluation_job_id: jobId,
                evaluation_sample_receipt_id: null,
                evaluation_attempt_id: attemptId,
                status: "fail",
                reason: null,
                score: { kind: "numeric", value: 0 },
                evidence_availability: "withheld",
              },
            ],
          },
        }}
        path="/w/wallie/analytics"
        preserved={{ factory: factoryId }}
        query={{ from: "2026-11-19", to: "2026-11-20" }}
        selectRevision
        workspaceSlug="wallie"
      />,
    );

    expect(
      screen.getByText("Release quality · Revision 2 · Policy 1 · 100% sampling"),
    ).toBeTruthy();
    expect(screen.getByText("/ 4 sampled").parentElement?.textContent).toBe("3 / 4 sampled");
    expect(screen.getByText("/ 3 usable").parentElement?.textContent).toBe("2 / 3 usable");
    const chartPoint = screen.getByRole("link", { name: /1 passed of 2 decided/ });
    const table = screen.getByRole("table", { name: "Scorer trend totals" });
    const dateLink = within(table).getByRole("link", { name: "Nov 19, 2026" });
    const url = new URL(dateLink.getAttribute("href") ?? "", "https://wallie.test");
    expect(chartPoint.getAttribute("href")).toBe(dateLink.getAttribute("href"));
    expect(url.searchParams.get("scoreSnapshot")).toBe(scoreSnapshot);
    expect(url.searchParams.get("evaluationDay")).toBe("2026-11-19");
    expect(url.searchParams.get("cohort")).toBe(policyId);
    expect(screen.getByText(/Score 0 · Evidence withheld/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open run" }).getAttribute("href")).toBe(
      `/w/wallie/runs/${runId}?evaluationAttempt=${attemptId}#evaluation-${jobId}`,
    );
  });
});
