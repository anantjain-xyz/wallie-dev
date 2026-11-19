import { factoryOAuthAuthorizationServerMetadata } from "@/lib/factory-mcp/resource";

export function GET(request: Request) {
  const metadata = factoryOAuthAuthorizationServerMetadata();
  if (!metadata)
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (new URL(request.url).origin !== metadata.issuer || request.url.includes("?")) {
    return new Response(null, { status: 404 });
  }
  return Response.json(metadata, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
