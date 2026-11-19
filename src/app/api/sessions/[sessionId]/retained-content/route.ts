import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";
import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { eraseRetainedContentRequestSchema } from "@/lib/run-retention/session-contracts";
import { canManageSessionRetainedContent } from "@/features/sessions/detail/retained-content-access";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };

async function loadRetainedContentScope(params: RouteContext["params"]) {
  const { sessionId } = reviewSessionParamsSchema.parse(await params);
  const context = await loadReviewContext(sessionId);
  const { data: scope, error } = await context.supabase
    .from("sessions")
    .select("factory_id")
    .eq("id", context.session.id)
    .eq("workspace_id", context.session.workspace_id)
    .maybeSingle();
  if (error) throw error;
  return scope ? { ...context, factoryId: scope.factory_id } : null;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const context = await loadRetainedContentScope(params);
    if (!context) return reviewJson({ error: "Session not found." }, 404);
    const { supabase, factoryId, session, member } = context;
    const [erasure, canManage] = await Promise.all([
      supabase.rpc("get_session_retained_content_erasure", {
        target_workspace_id: session.workspace_id,
        target_session_id: session.id,
      }),
      canManageSessionRetainedContent(
        supabase,
        { workspaceId: session.workspace_id, factoryId },
        member,
      ),
    ]);
    if (erasure.error) throw erasure.error;
    const erasedAt = erasure.data?.erased_at ?? null;
    return reviewJson({
      erasedAt,
      archivedAt: session.archived_at,
      canErase: Boolean(session.archived_at) && erasedAt === null && canManage,
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const context = await loadRetainedContentScope(params);
    if (!context) return reviewJson({ error: "Session not found." }, 404);
    if (!isFactoryExecutionAuthorityJsonRequest(request)) {
      return reviewJson({ error: "Send a JSON confirmation." }, 415);
    }
    const parsed = eraseRetainedContentRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return reviewJson({ error: "Confirm erasure for the displayed archive." }, 400);
    const { supabase, factoryId, session, member } = context;
    const gated = await enforceRateLimit("phaseAction", `${session.workspace_id}:${member.id}`);
    if (gated.response) return gated.response;
    const { data, error } = await supabase.rpc("erase_session_retained_content", {
      target_workspace_id: session.workspace_id,
      target_factory_id: factoryId,
      target_session_id: session.id,
      expected_archived_at: parsed.data.expectedArchivedAt,
    });
    if (error?.code === "42501")
      return reviewJson({ error: "Factory manager access is required." }, 403);
    if (error?.code === "P0002") return reviewJson({ error: "Session not found." }, 404);
    if (error?.code === "PT409") {
      return reviewJson(
        { error: "The archive changed or still has active work. Refresh the session." },
        409,
      );
    }
    if (error || !data?.erased_at)
      return reviewJson({ error: "Could not erase retained session content." }, 500);
    return reviewJson({ archivedAt: data.archived_at, erasedAt: data.erased_at, canErase: false });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
