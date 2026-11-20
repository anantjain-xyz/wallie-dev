import Link from "next/link";
import { z } from "zod";

import { PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import {
  browserRecordingAnchor,
  browserScreenshotAnchor,
} from "@/features/wallie/browser-evidence-contracts";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import type { RunScore } from "@/lib/factory-evaluations/score-trend-contracts";
import { loadRunScores } from "@/lib/factory-evaluations/score-trends";
import {
  workspaceRunDetailPath,
  workspaceScorerDetailPath,
  workspaceSessionDetailPath,
} from "@/lib/routes";

import { ScoreOutcome, scoreReasonDetail, scoreValue } from "./score-outcome";
import { scorerEvidenceLabels } from "./scorer-evidence-labels";

type Receipt = NonNullable<RunScore["receipt"]>;
type EvidenceLocation = NonNullable<Receipt["evidence_locations"]>[number];

function evidenceHref(
  citation: EvidenceLocation,
  receipt: Receipt,
  runHref: string,
  artifacts: Map<string, string>,
  diff: RunScore["diff"],
) {
  const { kind, id } = citation.reference;
  switch (kind) {
    case "artifact":
      return artifacts.get(id);
    case "validation_report":
      return `/api/sessions/${receipt.session_id}/validation-evidence/assets/${id}`;
    case "browser_screenshot":
      return `${runHref}#${browserScreenshotAnchor(id)}`;
    case "browser_recording":
      return `${runHref}#${browserRecordingAnchor(id, 0)}`;
    case "code_diff":
      if (id !== receipt.run_id || !diff || diff.input_sha === diff.output_sha) return undefined;
      return `https://github.com/${diff.repository_full_name}/compare/${diff.input_sha}...${diff.output_sha}`;
  }
}

const evidenceAction = {
  artifact: "Open artifact",
  validation_report: "Open validation report",
  browser_screenshot: "Open browser screenshot",
  browser_recording: "Open browser recording",
  code_diff: "Open code diff",
};

function locationLabel(location: EvidenceLocation["location"]) {
  if (location.kind === "lines") return `Lines ${location.startLine}–${location.endLine}`;
  if (location.kind === "time")
    return `${location.startMs / 1_000}–${location.endMs / 1_000} seconds`;
  return null;
}

function EvidenceLinks({
  receipt,
  runHref,
  artifacts,
  diff,
}: {
  receipt: Receipt;
  runHref: string;
  artifacts: Map<string, string>;
  diff: RunScore["diff"];
}) {
  if (receipt.evidence_availability !== "available") {
    return (
      <p className="type-secondary text-muted">
        {receipt.evidence_availability === "withheld"
          ? "Evidence withheld"
          : "Evidence unavailable"}
      </p>
    );
  }
  const citations: EvidenceLocation[] = receipt.evidence_locations?.length
    ? receipt.evidence_locations
    : (receipt.result?.evidence ?? []).map((reference) => ({
        reference,
        location: { kind: "whole" },
      }));
  return (
    <ul aria-label="Evaluation evidence" className="space-y-1">
      {citations.map((citation) => {
        const href = evidenceHref(citation, receipt, runHref, artifacts, diff);
        const kind = citation.reference.kind;
        const location = locationLabel(citation.location);
        return (
          <li
            key={`${kind}:${citation.reference.id}:${location ?? "whole"}`}
            className="type-secondary flex flex-wrap items-center gap-x-2 gap-y-1"
          >
            {href ? (
              <a
                className="rounded-sm text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent"
                href={href}
              >
                {evidenceAction[kind]}
              </a>
            ) : (
              <span className="text-muted">
                {kind === "code_diff" && diff && diff.input_sha === diff.output_sha
                  ? "No code changes"
                  : scorerEvidenceLabels[kind]}
              </span>
            )}
            {location ? <span className="text-muted">{location}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function RunScoresPanel({
  scores,
  workspaceSlug,
  factoryId,
  runId,
  evaluationAttempt,
  artifacts,
}: {
  scores: RunScore[];
  workspaceSlug: string;
  factoryId: string;
  runId: string;
  evaluationAttempt?: string;
  artifacts: Map<string, string>;
}) {
  const runHref = workspaceRunDetailPath(workspaceSlug, runId);
  return (
    <PageSection anchorId="scorer-evaluations" title="Scorer evaluations">
      <ul className="ui-sheet divide-y divide-border">
        {scores.map((score) => {
          const { receipt, job_status, sample_outcome, sample_reason } = score;
          const pending = job_status === "queued" || job_status === "claimed";
          const showReceipt = receipt && (!pending || receipt.attempt_id === evaluationAttempt);
          const result = showReceipt ? receipt : null;
          const reason = scoreReasonDetail(result?.reason ?? sample_reason);
          const sampleStatus =
            sample_outcome === "excluded" || sample_outcome === "not_sampled"
              ? sample_outcome
              : "unsettled";
          return (
            <li
              className="scroll-mt-24 space-y-2 px-4 py-4 sm:px-5"
              id={score.evaluation_job_id ? `evaluation-${score.evaluation_job_id}` : undefined}
              key={score.scorer_revision_id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  className="min-w-0 break-words font-semibold underline-offset-4 hover:text-accent hover:underline"
                  href={workspaceScorerDetailPath(workspaceSlug, score.scorer_id, {
                    factory: factoryId,
                    revision: score.scorer_revision_id,
                  })}
                  prefetch={false}
                >
                  {score.scorer_name} · Revision {score.scorer_revision_number}
                </Link>
                {result ? (
                  <ScoreOutcome status={result.status} reason={result.reason} />
                ) : pending || job_status === null ? (
                  <ScoreOutcome status={sampleStatus} reason={sample_reason} />
                ) : (
                  <Status
                    compact
                    label={job_status === "canceled" ? "Canceled" : "Judgment unavailable"}
                    value={job_status === "canceled" ? "canceled" : "needs_attention"}
                  />
                )}
              </div>
              {result ? (
                <>
                  <p className="type-secondary text-muted">
                    Attempt {result.attempt_number}
                    {result.score ? ` · Score ${scoreValue(result.score)}` : ""}
                    {reason ? ` · ${reason}` : ""}
                  </p>
                  {result.explanation ? (
                    <p className="type-secondary whitespace-pre-wrap break-words">
                      {result.explanation}
                    </p>
                  ) : null}
                  <EvidenceLinks
                    receipt={result}
                    runHref={runHref}
                    artifacts={artifacts}
                    diff={score.diff}
                  />
                </>
              ) : reason ? (
                <p className="type-secondary text-muted">{reason}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </PageSection>
  );
}

const attemptId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export async function RunScoreSection({
  workspaceSlug,
  sessionId,
  sessionNumber,
  runId,
  attempt,
}: {
  workspaceSlug: string;
  sessionId: string;
  sessionNumber: number;
  runId: string;
  attempt: string | string[] | undefined;
}) {
  const query = attemptId.optional().safeParse(attempt);
  const { supabase, workspace } = await loadAuthenticatedWorkspaceContext(workspaceSlug);
  const data = query.success
    ? await loadRunScores(supabase, {
        workspaceId: workspace.id,
        sessionId,
        runId,
        evaluationAttempt: query.data,
      }).catch(() => null)
    : null;
  if (!data || !data.scores.length) {
    return (
      <PageSection anchorId="scorer-evaluations" title="Scorer evaluations">
        <p className="ui-sheet type-secondary px-4 py-4 text-muted sm:px-5">
          {data
            ? "No scorer evaluations recorded for this run."
            : "Scorer evaluations are unavailable."}
        </p>
      </PageSection>
    );
  }

  const artifacts = new Map<string, string>();
  const ids = [
    ...new Set(
      data.scores.flatMap(
        ({ receipt }) =>
          receipt?.result?.evidence.filter(({ kind }) => kind === "artifact").map(({ id }) => id) ??
          [],
      ),
    ),
  ];
  if (ids.length) {
    const { data: references } = await supabase
      .from("session_artifacts")
      .select("id,stage_slug,version")
      .eq("workspace_id", workspace.id)
      .eq("session_id", sessionId)
      .in("id", ids);
    for (const artifact of references ?? []) {
      artifacts.set(
        artifact.id,
        workspaceSessionDetailPath(workspaceSlug, sessionNumber, {
          artifactId: artifact.id,
          artifactStage: artifact.stage_slug,
          artifactVersion: artifact.version,
        }),
      );
    }
  }
  return (
    <RunScoresPanel
      scores={data.scores}
      workspaceSlug={workspaceSlug}
      factoryId={data.factoryId}
      runId={runId}
      evaluationAttempt={query.success ? query.data : undefined}
      artifacts={artifacts}
    />
  );
}
