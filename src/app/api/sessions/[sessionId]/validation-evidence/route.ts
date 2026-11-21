import { loadArtifactEvidenceCheckpoint } from "@/lib/validation-evidence/artifact-links";
import { projectBrowserEvidenceReceipt } from "@/lib/validation-evidence/browser-evidence-view";
import {
  browserEvidenceSelection,
  browserScreenshotDownloadPath,
} from "@/features/wallie/browser-evidence-contracts";

import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };

/** These are recorded observations, not a readiness decision. */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const selection = browserEvidenceSelection(request.url);
    const { session, supabase } = await loadReviewContext(sessionId);
    const checkpoint = selection.artifactId
      ? await loadArtifactEvidenceCheckpoint({
          supabase,
          sessionId: session.id,
          workspaceId: session.workspace_id,
          artifactId: selection.artifactId,
        })
      : null;
    if (
      selection.artifactId &&
      (!checkpoint || (selection.runId && selection.runId !== checkpoint.runId))
    ) {
      return reviewJson({ error: "Evidence is unavailable for this artifact." }, 409);
    }
    const exactRunId = checkpoint?.runId ?? selection.runId;
    const commandQuery = supabase
      .from("session_validation_evidence")
      .select(
        "run_id, workspace_id, session_id, job_id, attempt_count, repository_id, repository_full_name, commit_sha, validation_tree_sha, records, created_at",
      )
      .eq("session_id", session.id)
      .eq("workspace_id", session.workspace_id);
    const browserQuery = supabase
      .from("session_browser_verification_receipts")
      .select(
        "run_id, records, created_at, plan:session_validation_plans!inner(attempt_count, commit_sha, validation_tree_sha, browser_plan:plan->browser)",
      )
      .eq("session_id", session.id)
      .eq("workspace_id", session.workspace_id);
    if (exactRunId) {
      commandQuery.eq("run_id", exactRunId);
      browserQuery.eq("run_id", exactRunId);
    }
    const [commands, browser] = await Promise.all([
      commandQuery
        .order("created_at", { ascending: false })
        .order("run_id", { ascending: false })
        .limit(exactRunId ? 1 : 10),
      browserQuery
        .order("created_at", { ascending: false })
        .order("run_id", { ascending: false })
        .limit(exactRunId ? 1 : 10),
    ]);
    const { data: evidence, error } = commands;
    if (error) throw error;
    if (browser.error) throw browser.error;
    const browserEvidence = (browser.data ?? []).flatMap((row) => {
      const projected = projectBrowserEvidenceReceipt(row, {
        expectedCommitSha: checkpoint?.commitSha,
        screenshotUrl: (assetId) =>
          browserScreenshotDownloadPath(session.id, assetId, {
            runId: exactRunId,
            artifactId: selection.artifactId,
          }),
      });
      return projected ? [projected] : [];
    });
    if (!evidence?.length) return reviewJson({ evidence: [], assets: [], browserEvidence });

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
      browserEvidence,
      assets: (assets ?? []).map((asset) => ({
        ...asset,
        downloadUrl: `/api/sessions/${session.id}/validation-evidence/assets/${asset.id}`,
      })),
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
