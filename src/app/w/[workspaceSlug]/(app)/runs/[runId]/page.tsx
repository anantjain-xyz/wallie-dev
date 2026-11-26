import { notFound } from "next/navigation";
import { z } from "zod";

import { CaptureBenchmarkRun } from "@/features/factory-benchmarks/capture-run.client";
import { RunScoreSection } from "@/features/factory-scorers/run-score-section";
import { RunInspector } from "@/features/wallie/run-inspector";
import { loadRunInspectorData } from "@/features/wallie/run-inspector-data";
import { RunTranscriptLive } from "@/features/wallie/run-transcript-live";
import { RunsListRefresh } from "@/features/wallie/runs-list-filters";
import { runListReturn } from "@/features/wallie/runs-list-state";
import { workspaceRunDetailPath } from "@/lib/routes";

const executionProfileAttempt = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(2_147_483_647))
  .optional();

export default async function RunInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug, runId }, query] = await Promise.all([params, searchParams]);
  const attempt = executionProfileAttempt.safeParse(query.attempt);
  if (!attempt.success) notFound();
  const data = await loadRunInspectorData(workspaceSlug, runId, attempt.data);
  const returnTo = runListReturn(data.workspaceSlug, query.fromRuns);
  const newerRunHref = data.run.newerRunId
    ? workspaceRunDetailPath(data.workspaceSlug, data.run.newerRunId) +
      (returnTo && typeof query.fromRuns === "string"
        ? `?${new URLSearchParams({ fromRuns: query.fromRuns })}`
        : "")
    : undefined;
  return (
    <RunInspector
      artifact={data.artifact}
      benchmarkCapture={
        data.canCaptureBenchmark ? (
          <CaptureBenchmarkRun
            key={data.run.id}
            workspaceId={data.workspaceId}
            runId={data.run.id}
          />
        ) : undefined
      }
      canOpenRoutingPolicy={data.canOpenRoutingPolicy}
      credential={data.credential}
      executionProfile={data.executionProfile}
      executionProfileAttempt={attempt.data}
      frozenContext={data.frozenContext}
      evaluations={
        <RunScoreSection
          workspaceSlug={data.workspaceSlug}
          runId={data.run.id}
          sessionId={data.run.sessionId}
          sessionNumber={data.run.sessionNumber}
          attempt={query.evaluationAttempt}
          governanceQuery={query}
        />
      }
      memoryProposalHref={data.memoryProposalHref}
      mcp={data.mcp}
      names={data.names}
      newerRunHref={newerRunHref}
      returnTo={returnTo}
      initialNow={new Date().toISOString()}
      routingDecision={data.routingDecision}
      run={data.run}
      skills={data.skills}
      workspaceId={data.workspaceId}
      workspaceSlug={data.workspaceSlug}
      workflowInspection={data.workflowInspection ?? undefined}
      transcript={
        data.transcript ? (
          <RunTranscriptLive
            key={`${data.run.id}:${data.transcript.attemptCount}`}
            initialPage={data.transcript}
            runId={data.run.id}
            workspaceId={data.workspaceId}
          />
        ) : (
          <section
            className="ui-sheet space-y-3 p-4 sm:p-6"
            aria-labelledby="transcript-unavailable"
          >
            <h2 id="transcript-unavailable" className="type-heading text-foreground">
              Transcript
            </h2>
            <p className="type-body text-muted">
              The transcript couldn’t load. The run outcome and other evidence are still available.
            </p>
            <RunsListRefresh label="Try again" />
          </section>
        )
      }
    />
  );
}
