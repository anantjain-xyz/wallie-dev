import { z } from "zod";

import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";
import {
  BROWSER_VIDEO_ASSET_FIELDS,
  readPrivateBrowserVideo,
} from "@/lib/validation-evidence/browser-assets";
import { loadArtifactEvidenceCheckpoint } from "@/lib/validation-evidence/artifact-links";
import { browserEvidenceSelection } from "@/features/wallie/browser-evidence-contracts";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string; assetId: string }> };
const paramsSchema = reviewSessionParamsSchema.extend({ assetId: z.string().uuid() });

/** Authorize the exact private recording and verify its retained bytes before download. */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { sessionId, assetId } = paramsSchema.parse(await params);
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
    const query = supabase
      .from("session_browser_verification_assets")
      .select(BROWSER_VIDEO_ASSET_FIELDS)
      .eq("id", assetId)
      .eq("workspace_id", session.workspace_id)
      .eq("session_id", session.id)
      .eq("content_type", "video/webm");
    if (exactRunId) query.eq("run_id", exactRunId);
    const { data: asset, error } = await query.abortSignal(request.signal).maybeSingle();
    if (error) throw error;
    if (!asset) return reviewJson({ error: "Evidence video not found." }, 404);
    if (checkpoint) {
      const { data: plan, error: planError } = await supabase
        .from("session_validation_plans")
        .select("commit_sha")
        .eq("run_id", checkpoint.runId)
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .abortSignal(request.signal)
        .maybeSingle();
      if (planError || plan?.commit_sha !== checkpoint.commitSha) {
        return reviewJson({ error: "Evidence is unavailable for this artifact." }, 409);
      }
    }

    const result = await readPrivateBrowserVideo({
      supabase,
      workspaceId: session.workspace_id,
      sessionId: session.id,
      runId: asset.run_id,
      asset,
      signal: request.signal,
    });
    if (result.status !== "available") {
      return reviewJson({ error: "Evidence video is unavailable." }, 409);
    }
    return new Response(result.bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "video/webm",
        "Content-Disposition": `attachment; filename="evidence-${assetId}.webm"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
