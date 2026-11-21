import { listBenchmarkComparisons } from "@/lib/factory-benchmarks/comparison";
import { benchmarkComparisonListQuerySchema } from "@/lib/factory-benchmarks/comparison-contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

import {
  comparisonBadRequest,
  comparisonFailure,
  comparisonQuery,
  resolveComparisonScope,
  type ComparisonFactoryParams,
} from "../comparison-responses";

export async function GET(
  request: Request,
  { params }: { params: Promise<ComparisonFactoryParams> },
) {
  const query = benchmarkComparisonListQuerySchema.safeParse(comparisonQuery(request));
  if (!query.success) return comparisonBadRequest("Provide a valid suite and comparison cursor.");
  try {
    const context = await resolveComparisonScope(await params, request);
    if (!context.ok) return context.response;
    return Response.json(await listBenchmarkComparisons(context.scope, query.data), { headers });
  } catch (error) {
    return comparisonFailure(error, "Could not load benchmark comparisons.");
  }
}
