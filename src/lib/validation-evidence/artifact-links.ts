import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type ArtifactEvidenceContext = {
  supabase: SupabaseClient<Database>;
  sessionId: string;
  workspaceId: string;
  artifactId: string;
};

/** An immutable checkpoint, never a latest run or timestamp, owns artifact evidence. */
export async function loadArtifactEvidenceRun({
  supabase,
  sessionId,
  workspaceId,
  artifactId,
}: ArtifactEvidenceContext): Promise<string | null> {
  const { data: checkpoint, error: checkpointError } = await supabase
    .from("session_git_checkpoints")
    .select("run_id, output_sha")
    .eq("artifact_id", artifactId)
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (checkpointError || !checkpoint) return null;

  const { data: receipt, error: receiptError } = await supabase
    .from("session_validation_evidence")
    .select("run_id, commit_sha")
    .eq("run_id", checkpoint.run_id)
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (receiptError || !receipt || receipt.commit_sha !== checkpoint.output_sha) return null;
  return receipt.run_id;
}

/** RLS-scoped, authenticated asset routes are the only destinations for evidence aliases. */
export async function loadArtifactEvidenceLinks(
  input: ArtifactEvidenceContext,
): Promise<ReadonlyMap<string, string>> {
  const links = new Map<string, string>();
  const runId = await loadArtifactEvidenceRun(input);
  if (!runId) return links;

  const { data: assets, error } = await input.supabase
    .from("session_validation_assets")
    .select("id, evidence_key")
    .eq("run_id", runId)
    .eq("session_id", input.sessionId)
    .eq("workspace_id", input.workspaceId)
    .limit(100);
  if (error) return links;
  for (const asset of assets ?? []) {
    links.set(
      `wallie-evidence:${asset.evidence_key}`,
      `/api/sessions/${input.sessionId}/validation-evidence/assets/${asset.id}?artifactId=${input.artifactId}`,
    );
  }
  return links;
}
