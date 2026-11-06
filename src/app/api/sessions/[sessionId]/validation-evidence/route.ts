import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };

/** These are recorded observations, not a readiness decision. */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const { session, supabase } = await loadReviewContext(sessionId);
    const { data: evidence, error } = await supabase
      .from("session_validation_evidence")
      .select(
        "run_id, workspace_id, session_id, job_id, attempt_count, repository_id, repository_full_name, commit_sha, validation_tree_sha, records, created_at",
      )
      .eq("session_id", session.id)
      .eq("workspace_id", session.workspace_id)
      .order("created_at", { ascending: false })
      .order("run_id", { ascending: false })
      .limit(10);
    if (error) throw error;
    if (!evidence?.length) return reviewJson({ evidence: [], assets: [] });

    // Ten receipts with at most 100 manifests each fit within PostgREST's
    // default 1,000-row ceiling, preserving every selected receipt's assets.
    const { data: assets, error: assetError } = await supabase
      .from("session_validation_assets")
      .select("id, run_id, evidence_key, kind, required, sha256, content_type, size_bytes")
      .eq("session_id", session.id)
      .eq("workspace_id", session.workspace_id)
      .in(
        "run_id",
        evidence.map((item) => item.run_id),
      )
      .order("id", { ascending: true })
      .limit(1000);
    if (assetError) throw assetError;
    return reviewJson({
      evidence,
      assets: (assets ?? []).map((asset) => ({
        ...asset,
        downloadUrl: `/api/sessions/${session.id}/validation-evidence/assets/${asset.id}`,
      })),
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
