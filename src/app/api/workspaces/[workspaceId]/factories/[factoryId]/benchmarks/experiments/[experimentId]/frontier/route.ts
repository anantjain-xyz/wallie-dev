import { readBenchmarkFrontier } from "@/lib/factory-benchmarks/comparison";
import { benchmarkComparisonIdSchema } from "@/lib/factory-benchmarks/comparison-contracts";
import { benchmarkFrontierQuerySchema } from "@/lib/factory-benchmarks/frontier-contracts";
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
    const query = benchmarkFrontierQuerySchema.safeParse(comparisonQuery(request));
    if (!experimentId.success || !query.success) {
      return comparisonBadRequest("Provide a valid experiment, frontier constraints, and cursor.");
    }
    const context = await resolveComparisonScope(path, request);
    if (!context.ok) return context.response;
    const frontier = await readBenchmarkFrontier(
      { ...context.scope, experimentId: experimentId.data },
      query.data,
    );
    return Response.json(frontier, { headers });
  } catch (error) {
    return comparisonFailure(error, "Could not load the cost and quality frontier.");
  }
}
