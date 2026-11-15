import { z } from "zod";

import {
  loadReviewArtifact,
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";

export const preferredRegion = "home";
const paramsSchema = reviewSessionParamsSchema.extend({ artifactId: z.string().uuid() });

type RouteContext = { params: Promise<{ sessionId: string; artifactId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { sessionId, artifactId } = paramsSchema.parse(await params);
    const context = await loadReviewContext(sessionId);
    const { supabase } = context;
    const [artifact, { data: workspace, error: workspaceError }] = await Promise.all([
      loadReviewArtifact(context, artifactId),
      supabase
        .from("workspaces")
        .select("slug")
        .eq("id", context.session.workspace_id)
        .is("deletion_requested_at", null)
        .abortSignal(request.signal)
        .maybeSingle(),
    ]);
    if (workspaceError) throw workspaceError;
    if (!workspace) return reviewJson({ error: "Workspace not found." }, 404);

    const { data: checkpoint, error: checkpointError } = await supabase
      .from("session_git_checkpoints")
      .select("run_id")
      .eq("workspace_id", artifact.workspace_id)
      .eq("session_id", artifact.session_id)
      .eq("artifact_id", artifact.id)
      .abortSignal(request.signal)
      .maybeSingle();
    if (checkpointError) throw checkpointError;
    return reviewJson({
      workspaceId: artifact.workspace_id,
      workspaceSlug: workspace.slug,
      runId: checkpoint?.run_id ?? null,
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
