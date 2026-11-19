import { handleFactoryDeploymentObservation } from "@/lib/factory-deployments/server";

export const preferredRegion = "home";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

export async function POST(request: Request, { params }: Context) {
  return handleFactoryDeploymentObservation(request, await params);
}
