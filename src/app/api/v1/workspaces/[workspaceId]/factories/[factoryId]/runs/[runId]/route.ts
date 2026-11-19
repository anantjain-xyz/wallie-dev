import { handleFactoryRead } from "@/lib/factory-read-api/server";

export const preferredRegion = "home";

type Context = { params: Promise<{ workspaceId: string; factoryId: string; runId: string }> };

export async function GET(request: Request, { params }: Context) {
  return handleFactoryRead("run", request, await params);
}
