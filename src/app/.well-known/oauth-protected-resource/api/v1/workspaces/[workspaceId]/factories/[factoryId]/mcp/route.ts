import {
  factoryMcpProtectedResourceMetadata,
  factoryMcpProtectedResourceMetadataUrl,
  factoryMcpResource,
  factoryMcpScopeSchema,
} from "@/lib/factory-mcp/resource";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; factoryId: string }> },
) {
  const scope = factoryMcpScopeSchema.safeParse(await params);
  if (!scope.success) return new Response(null, { status: 404 });
  const resource = factoryMcpResource(scope.data);
  if (!resource)
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  const metadataUrl = factoryMcpProtectedResourceMetadataUrl(resource);
  const url = new URL(request.url);
  if (
    url.origin !== metadataUrl.origin ||
    url.pathname !== metadataUrl.pathname ||
    request.url.includes("?")
  ) {
    return new Response(null, { status: 404 });
  }
  return Response.json(factoryMcpProtectedResourceMetadata(resource), {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
