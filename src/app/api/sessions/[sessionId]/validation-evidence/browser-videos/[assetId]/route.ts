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

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string; assetId: string }> };
const paramsSchema = reviewSessionParamsSchema.extend({ assetId: z.string().uuid() });

/** Authorize the exact private recording and verify its retained bytes before download. */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { sessionId, assetId } = paramsSchema.parse(await params);
    const { session, supabase } = await loadReviewContext(sessionId);
    const { data: asset, error } = await supabase
      .from("session_browser_verification_assets")
      .select(BROWSER_VIDEO_ASSET_FIELDS)
      .eq("id", assetId)
      .eq("workspace_id", session.workspace_id)
      .eq("session_id", session.id)
      .eq("content_type", "video/webm")
      .abortSignal(request.signal)
      .maybeSingle();
    if (error) throw error;
    if (!asset) return reviewJson({ error: "Evidence video not found." }, 404);

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
