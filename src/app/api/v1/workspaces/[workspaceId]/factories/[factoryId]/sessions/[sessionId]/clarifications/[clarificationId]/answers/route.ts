import { handleFactoryMutation } from "@/lib/factory-session-mutations/server";

export const preferredRegion = "home";

type Context = {
  params: Promise<{
    workspaceId: string;
    factoryId: string;
    sessionId: string;
    clarificationId: string;
  }>;
};

export async function POST(request: Request, { params }: Context) {
  return handleFactoryMutation("answer_clarification", request, await params);
}
