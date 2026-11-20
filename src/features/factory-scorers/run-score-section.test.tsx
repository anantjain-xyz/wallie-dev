// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { loadRunScores } from "@/lib/factory-evaluations/score-trends";
import type { RunScore } from "@/lib/factory-evaluations/score-trend-contracts";

import { RunScoreSection } from "./run-score-section";

vi.mock("@/lib/factory-evaluations/score-trends", () => ({ loadRunScores: vi.fn() }));
vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: async () => ({ workspace: { id: workspaceId }, supabase: {} }),
}));

const workspaceId = "608a0000-0000-4000-8000-000000000001";
const factoryId = "608a0000-0000-4000-8000-000000000002";
const sessionId = "608a0000-0000-4000-8000-000000000003";
const runId = "608a0000-0000-4000-8000-000000000004";
const scorerId = "608a0000-0000-4000-8000-000000000005";
const revisionId = "608a0000-0000-4000-8000-000000000006";
const jobId = "608a0000-0000-4000-8000-000000000007";
const attemptId = "608a0000-0000-4000-8000-000000000008";
const reportId = "608a0000-0000-4000-8000-000000000009";
const sampleId = "608a0000-0000-4000-8000-000000000010";
const at = "2026-11-19T18:30:00Z";
const scoreRow = {
  evaluation_job_id: null,
  scorer_id: scorerId,
  scorer_revision_id: revisionId,
  scorer_revision_number: 2,
  scorer_name: "Release quality",
  scorer_slug: "release-quality",
  sample_outcome: "excluded",
  sample_reason: "missing_evidence",
  job_status: null,
  receipt: null,
  diff: null,
} satisfies RunScore;
const evaluated = {
  ...scoreRow,
  evaluation_job_id: jobId,
  job_status: "succeeded",
  sample_outcome: "sampled",
  sample_reason: null,
  receipt: {
    attempt_id: attemptId,
    workspace_id: workspaceId,
    factory_id: factoryId,
    job_id: jobId,
    session_id: sessionId,
    run_id: runId,
    scorer_revision_id: revisionId,
    sample_receipt_id: sampleId,
    target_commit_sha: "e".repeat(40),
    attempt_number: 1,
    attempt_outcome: "succeeded",
    profile_revision_id: null,
    provider_model: null,
    provider_name: null,
    provider_request_id: null,
    adapter_runtime: "openrouter-chat-v1",
    worker_runtime: null,
    evidence_digest: "c".repeat(64),
    status: "fail",
    reason: null,
    score: { kind: "boolean", value: false },
    result: {
      schemaVersion: 1,
      status: "fail",
      score: { kind: "boolean", value: false },
      evidence: [{ kind: "validation_report", id: reportId }],
    },
    explanation: "The report records two failed checks.",
    evidence_locations: [
      {
        reference: { kind: "validation_report", id: reportId },
        location: { kind: "lines", startLine: 1, endLine: 2 },
      },
    ],
    claimed_at: at,
    started_at: at,
    finished_at: at,
    latency_ms: 0,
    input_tokens: null,
    output_tokens: null,
    token_provenance: "unavailable",
    cost_usd: null,
    cost_provenance: "unavailable",
    estimation_revision: null,
    evidence_availability: "available",
  },
} satisfies RunScore;

describe("run score section", () => {
  it("links exact available evidence and distinguishes sample-only dispositions", async () => {
    vi.mocked(loadRunScores).mockResolvedValue({
      factoryId,
      scores: [
        evaluated,
        { ...scoreRow, scorer_revision_id: sampleId },
        {
          ...scoreRow,
          scorer_revision_id: reportId,
          sample_outcome: "not_sampled",
          sample_reason: null,
        },
      ],
    });
    render(
      await RunScoreSection({
        workspaceSlug: "wallie",
        sessionId,
        sessionNumber: 2,
        runId,
        attempt: attemptId,
      }),
    );
    expect(screen.getByRole("heading", { name: "Scorer evaluations" })).toBeTruthy();
    expect(screen.getByText("Missing evidence")).toBeTruthy();
    expect(screen.getByText("Not sampled")).toBeTruthy();
    const item = document.getElementById(`evaluation-${jobId}`);
    expect(item).toBeTruthy();
    const link = within(item ?? document.body).getByRole("link", {
      name: "Open validation report",
    });
    expect(link.getAttribute("href")).toBe(
      `/api/sessions/${sessionId}/validation-evidence/assets/${reportId}`,
    );
    expect(within(item ?? document.body).getByText("Lines 1–2")).toBeTruthy();
    expect(vi.mocked(loadRunScores)).toHaveBeenLastCalledWith(
      {},
      { workspaceId, sessionId, runId, evaluationAttempt: attemptId },
    );
  });

  it("opens the evidence's own attempt and the exact cited offset even when another scorer is selected", async () => {
    const otherAttempt = "608a0000-0000-4000-8000-000000000011";
    const browserEvidenceJob = "608a0000-0000-4000-8000-000000000012";
    const browserEvidenceRevision = "608a0000-0000-4000-8000-000000000013";
    const screenshotId = "608a0000-0000-4000-8000-000000000014";
    const recordingId = "608a0000-0000-4000-8000-000000000015";
    const locations: NonNullable<NonNullable<RunScore["receipt"]>["evidence_locations"]> = [
      { reference: { kind: "browser_screenshot", id: screenshotId }, location: { kind: "whole" } },
      {
        reference: { kind: "browser_recording", id: recordingId },
        location: { kind: "time", startMs: 750, endMs: 1000 },
      },
    ];
    vi.mocked(loadRunScores).mockResolvedValue({
      factoryId,
      scores: [
        evaluated,
        {
          ...evaluated,
          evaluation_job_id: browserEvidenceJob,
          scorer_revision_id: browserEvidenceRevision,
          receipt: {
            ...evaluated.receipt,
            attempt_id: otherAttempt,
            job_id: browserEvidenceJob,
            scorer_revision_id: browserEvidenceRevision,
            result: {
              ...evaluated.receipt.result,
              evidence: locations.map(({ reference }) => reference),
            },
            evidence_locations: locations,
          },
        },
      ],
    });
    render(
      await RunScoreSection({
        workspaceSlug: "wallie",
        sessionId,
        sessionNumber: 2,
        runId,
        attempt: attemptId,
      }),
    );
    const path = `/w/wallie/runs/${runId}?evaluationAttempt=${otherAttempt}`;
    expect(screen.getByRole("link", { name: "Open browser screenshot" }).getAttribute("href")).toBe(
      `${path}#browser-screenshot-${screenshotId}`,
    );
    expect(screen.getByRole("link", { name: "Open browser recording" }).getAttribute("href")).toBe(
      `${path}#browser-recording-citation-${recordingId}-750`,
    );
  });

  it("keeps the verdict while withholding evidence and its explanation", async () => {
    vi.mocked(loadRunScores).mockResolvedValue({
      factoryId,
      scores: [
        {
          ...evaluated,
          receipt: {
            ...evaluated.receipt,
            evidence_availability: "withheld",
            evidence_digest: null,
            result: null,
            explanation: null,
            evidence_locations: null,
          },
        },
      ],
    });
    render(
      await RunScoreSection({
        workspaceSlug: "wallie",
        sessionId,
        sessionNumber: 2,
        runId,
        attempt: undefined,
      }),
    );
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Evidence withheld")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open validation report" })).toBeNull();
    expect(screen.queryByText(evaluated.receipt.explanation)).toBeNull();
  });
});
