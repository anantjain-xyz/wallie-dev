import { diagnosisRequestSchema, diagnosisTargetIdSchema } from "@/lib/factory-diagnosis/contracts";
import { diagnosisError, diagnosisFailure, diagnosisResponse } from "@/lib/factory-diagnosis/http";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { isSameOriginFactoryOAuthPost } from "@/lib/factory-oauth/browser-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; cohortId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  if (!isSameOriginFactoryOAuthPost(request))
    return diagnosisError("Send this request from Wallie.", 403);

  const cohort = diagnosisTargetIdSchema.safeParse((await params).cohortId);
  if (!cohort.success) return diagnosisError("Provide a valid failure cohort ID.", 400);

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const raw = await readBoundedJsonBody(request, 1024);
    if (!raw.ok && raw.code === "request_too_large")
      return diagnosisError("The diagnosis request is too large.", 413);
    if (!raw.ok && raw.code === "unsupported_media_type")
      return diagnosisError("Send the diagnosis request as JSON.", 415);
    const command = diagnosisRequestSchema.safeParse(raw.ok ? raw.body : null);
    if (!command.success) return diagnosisError("Check the diagnosis request fields.", 400);
    const { data, error } = await createSupabaseAdminClient()
      .rpc("request_factory_diagnosis", {
        p_workspace_id: context.access.workspace.id,
        p_factory_id: context.factoryId,
        p_actor_user_id: context.access.user.id,
        p_cohort_id: cohort.data,
        p_request_id: command.data.requestId,
        p_prompt_revision_id: command.data.promptRevisionId,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) return diagnosisFailure(error);
    return diagnosisResponse(data, 202);
  } catch (error) {
    return diagnosisFailure(error);
  }
}
