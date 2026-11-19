import { factoryReadOpenApi } from "@/lib/factory-read-api/openapi";

export function GET() {
  return Response.json(factoryReadOpenApi, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
