import { z } from "zod";

import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";
import { loadArtifactEvidenceRun } from "@/lib/validation-evidence/artifact-links";
import { readPrivateValidationAsset } from "@/lib/validation-evidence/private-asset";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string; assetId: string }> };
const paramsSchema = reviewSessionParamsSchema.extend({ assetId: z.string().uuid() });
const querySchema = z.object({ artifactId: z.string().uuid().optional() });

/** Reauthorize on each request; persisted evidence never contains a bearer URL. */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { sessionId, assetId } = paramsSchema.parse(await params);
    const { artifactId } = querySchema.parse({
      artifactId: new URL(request.url).searchParams.get("artifactId") ?? undefined,
    });
    const { session, supabase } = await loadReviewContext(sessionId);
    const { data: asset, error } = await supabase
      .from("session_validation_assets")
      .select("id, run_id, storage_path, sha256, content_type, size_bytes")
      .eq("id", assetId)
      .eq("session_id", session.id)
      .eq("workspace_id", session.workspace_id)
      .maybeSingle();
    if (error) throw error;
    if (!asset) return reviewJson({ error: "Evidence asset not found." }, 404);
    if (
      artifactId &&
      (await loadArtifactEvidenceRun({
        supabase,
        sessionId: session.id,
        workspaceId: session.workspace_id,
        artifactId,
      })) !== asset.run_id
    ) {
      return reviewJson({ error: "Evidence is unavailable for this artifact." }, 409);
    }
    const result = await readPrivateValidationAsset({
      supabase,
      workspaceId: session.workspace_id,
      asset,
      signal: request.signal,
    });
    if (result.status !== "available") {
      return reviewJson({ error: "Evidence asset is unavailable." }, 409);
    }
    return new Response(result.bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="evidence-${assetId}.txt"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
