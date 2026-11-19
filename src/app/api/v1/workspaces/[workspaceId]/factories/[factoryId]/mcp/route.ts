import { handleFactoryMcp } from "@/lib/factory-mcp/server";

export const runtime = "nodejs";

async function handle(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; factoryId: string }> },
) {
  return handleFactoryMcp(request, await params);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
