import { notFound } from "next/navigation";
import { z } from "zod";

import { CaptureBenchmarkRun } from "@/features/factory-benchmarks/capture-run.client";
import { RunScoreSection } from "@/features/factory-scorers/run-score-section";
import { RunInspector } from "@/features/wallie/run-inspector";
import { loadRunInspectorData } from "@/features/wallie/run-inspector-data";
import { RunTranscriptLive } from "@/features/wallie/run-transcript-live";

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
  const canCaptureBenchmark =
    (data.run.status === "success" ||
      data.run.status === "error" ||
      data.run.status === "canceled") &&
    (data.frozenContext.kind !== "recorded" || data.frozenContext.context.canManage);
  return (
    <RunInspector
      artifact={data.artifact}
      benchmarkCapture={
        canCaptureBenchmark ? (
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
      initialNow={new Date().toISOString()}
      routingDecision={data.routingDecision}
      run={data.run}
      skills={data.skills}
      workspaceId={data.workspaceId}
      workspaceSlug={data.workspaceSlug}
      workflowInspection={data.workflowInspection ?? undefined}
      transcript={
        <RunTranscriptLive
          initialPage={data.transcript}
          runId={data.run.id}
          workspaceId={data.workspaceId}
        />
      }
    />
  );
}
