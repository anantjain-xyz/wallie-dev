import { RunScoreSection } from "@/features/factory-scorers/run-score-section";
import { RunInspector } from "@/features/wallie/run-inspector";
import { loadRunInspectorData } from "@/features/wallie/run-inspector-data";
import { RunTranscriptLive } from "@/features/wallie/run-transcript-live";

export default async function RunInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug, runId }, query] = await Promise.all([params, searchParams]);
  const data = await loadRunInspectorData(workspaceSlug, runId);
  return (
    <RunInspector
      artifact={data.artifact}
      credential={data.credential}
      executionProfile={data.executionProfile}
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
      run={data.run}
      skills={data.skills}
      workspaceId={data.workspaceId}
      workspaceSlug={data.workspaceSlug}
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
