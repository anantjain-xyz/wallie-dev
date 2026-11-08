import { createHash } from "node:crypto";
import { z } from "zod";

import { loadArtifactEvidenceRun } from "@/lib/validation-evidence/artifact-links";
import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string; assetId: string }> };
const paramsSchema = reviewSessionParamsSchema.extend({ assetId: z.string().uuid() });
const querySchema = z.object({ artifactId: z.string().uuid().optional() });
const MAX_ASSET_BYTES = 1024 * 1024;

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
    if (
      !Number.isSafeInteger(asset.size_bytes) ||
      asset.size_bytes < 0 ||
      asset.size_bytes > MAX_ASSET_BYTES ||
      !["text/plain", "application/json"].includes(asset.content_type) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      asset.storage_path !== `${session.workspace_id}/${asset.run_id}/${asset.id}`
    ) {
      return reviewJson({ error: "Evidence asset is unavailable." }, 409);
    }

    const { data, error: downloadError } = await supabase.storage
      .from("session-validation-evidence")
      .download(asset.storage_path);
    if (downloadError || !data || data.size !== asset.size_bytes) {
      return reviewJson({ error: "Evidence asset is unavailable." }, 409);
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      return reviewJson({ error: "Evidence asset is unavailable." }, 409);
    }
    return new Response(bytes, {
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
