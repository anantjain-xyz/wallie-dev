import { handleFactoryMutation } from "@/lib/factory-session-mutations/server";
import { handleFactoryRead } from "@/lib/factory-read-api/server";

export const preferredRegion = "home";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

export async function GET(request: Request, { params }: Context) {
  return handleFactoryRead("sessions", request, await params);
}

export async function POST(request: Request, { params }: Context) {
  return handleFactoryMutation("create", request, await params);
}
