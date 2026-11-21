import "server-only";

import { BenchmarkComparisonError } from "@/lib/factory-benchmarks/comparison";
import type { BenchmarkComparisonExportPart } from "@/lib/factory-benchmarks/comparison-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ComparisonFactoryParams = { workspaceId: string; factoryId: string };
export type ComparisonExperimentParams = ComparisonFactoryParams & { experimentId: string };

export async function resolveComparisonScope(params: ComparisonFactoryParams, request: Request) {
  const context = await resolveFactoryRouteContext(Promise.resolve(params));
  if (!context.ok) return context;
  return {
    ok: true as const,
    scope: {
      admin: createSupabaseAdminClient(),
      workspaceId: context.workspaceId,
      factoryId: context.factoryId,
      actorUserId: context.access.user.id,
      signal: request.signal,
    },
  };
}

export function comparisonQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  return new Set(params.keys()).size === params.size ? Object.fromEntries(params) : null;
}

export function comparisonBadRequest(error: string) {
  return Response.json({ error }, { status: 400, headers });
}

export function comparisonFailure(error: unknown, message: string) {
  if (error instanceof BenchmarkComparisonError) {
    return Response.json({ error: error.message }, { status: error.status, headers });
  }
  return Response.json({ error: message }, { status: 500, headers });
}

export function comparisonDownload(
  body: string,
  exportId: string,
  part?: BenchmarkComparisonExportPart,
) {
  const name = !part
    ? "manifest"
    : `${part.kind === "candidates" ? "candidate-part" : "part"}-${part.ordinal}`;
  return new Response(body, {
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="benchmark-${exportId}-${name}.json"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
