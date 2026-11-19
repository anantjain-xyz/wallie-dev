import { handleFactoryRead } from "@/lib/factory-read-api/server";

export const preferredRegion = "home";

type Context = { params: Promise<{ workspaceId: string; factoryId: string; sessionId: string }> };

export async function GET(request: Request, { params }: Context) {
  return handleFactoryRead("session", request, await params);
}
