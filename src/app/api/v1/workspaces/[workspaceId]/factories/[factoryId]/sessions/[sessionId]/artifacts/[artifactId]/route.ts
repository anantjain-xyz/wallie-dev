import { handleFactoryRead } from "@/lib/factory-read-api/server";

export const preferredRegion = "home";

type Context = {
  params: Promise<{
    workspaceId: string;
    factoryId: string;
    sessionId: string;
    artifactId: string;
  }>;
};

export async function GET(request: Request, { params }: Context) {
  return handleFactoryRead("artifact", request, await params);
}
