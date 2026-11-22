import { diagnosisTargetIdSchema } from "@/lib/factory-diagnosis/contracts";
import { diagnosisError, diagnosisFailure } from "@/lib/factory-diagnosis/http";
import { factoryResponseHeaders, resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; diagnosisId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const diagnosis = diagnosisTargetIdSchema.safeParse((await params).diagnosisId);
  if (!diagnosis.success) return diagnosisError("Provide a valid diagnosis ID.", 400);

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const { data, error } = await createSupabaseAdminClient()
      .rpc("cancel_factory_diagnosis", {
        p_workspace_id: context.access.workspace.id,
        p_factory_id: context.factoryId,
        p_actor_user_id: context.access.user.id,
        p_diagnosis_id: diagnosis.data,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) return diagnosisFailure(error);
    if (data !== true) return diagnosisError("The diagnosis can no longer be canceled.", 409);
    return Response.json({ canceled: true }, { headers: factoryResponseHeaders });
  } catch (error) {
    return diagnosisFailure(error);
  }
}
