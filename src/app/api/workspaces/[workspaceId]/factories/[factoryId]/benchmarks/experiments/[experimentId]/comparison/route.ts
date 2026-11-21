import { readBenchmarkComparison } from "@/lib/factory-benchmarks/comparison";
import {
  benchmarkComparisonIdSchema,
  benchmarkComparisonQuerySchema,
} from "@/lib/factory-benchmarks/comparison-contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

import {
  comparisonBadRequest,
  comparisonFailure,
  comparisonQuery,
  resolveComparisonScope,
  type ComparisonExperimentParams,
} from "../../../comparison-responses";

export async function GET(
  request: Request,
  { params }: { params: Promise<ComparisonExperimentParams> },
) {
  try {
    const path = await params;
    const experimentId = benchmarkComparisonIdSchema.safeParse(path.experimentId);
    const query = benchmarkComparisonQuerySchema.safeParse(comparisonQuery(request));
    if (!experimentId.success || !query.success) {
      return comparisonBadRequest("Provide a valid experiment and trial cursor.");
    }
    const context = await resolveComparisonScope(path, request);
    if (!context.ok) return context.response;
    const comparison = await readBenchmarkComparison(
      { ...context.scope, experimentId: experimentId.data },
      query.data,
    );
    return Response.json(comparison, { headers });
  } catch (error) {
    return comparisonFailure(error, "Could not load the benchmark comparison.");
  }
}
