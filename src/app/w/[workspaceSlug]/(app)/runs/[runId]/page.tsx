import { RunInspector } from "@/features/wallie/run-inspector";
import { loadRunInspectorData } from "@/features/wallie/run-inspector-data";
import { RunTranscriptLive } from "@/features/wallie/run-transcript-live";

export default async function RunInspectorPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; runId: string }>;
}) {
  const { workspaceSlug, runId } = await params;
  const data = await loadRunInspectorData(workspaceSlug, runId);
  return (
    <RunInspector
      artifact={data.artifact}
      credential={data.credential}
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
