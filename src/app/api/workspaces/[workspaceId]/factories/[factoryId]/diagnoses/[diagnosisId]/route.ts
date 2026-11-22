import { diagnosisTargetIdSchema } from "@/lib/factory-diagnosis/contracts";
import { diagnosisError, diagnosisFailure, diagnosisResponse } from "@/lib/factory-diagnosis/http";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; diagnosisId: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const diagnosis = diagnosisTargetIdSchema.safeParse((await params).diagnosisId);
  if (!diagnosis.success) return diagnosisError("Provide a valid diagnosis ID.", 400);

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const { data, error } = await context.access.supabase
      .rpc("get_factory_diagnosis", {
        p_workspace_id: context.access.workspace.id,
        p_factory_id: context.factoryId,
        p_diagnosis_id: diagnosis.data,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) return diagnosisFailure(error);
    if (data === null) return diagnosisError("The diagnosis is unavailable.", 404);
    return diagnosisResponse(data);
  } catch (error) {
    return diagnosisFailure(error);
  }
}
