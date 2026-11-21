import {
  createBenchmarkComparisonExport,
  listBenchmarkComparisonExports,
} from "@/lib/factory-benchmarks/comparison";
import {
  benchmarkComparisonExportListQuerySchema,
  benchmarkComparisonExportRequestSchema,
  benchmarkComparisonIdSchema,
} from "@/lib/factory-benchmarks/comparison-contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

import {
  comparisonBadRequest,
  comparisonFailure,
  comparisonQuery,
  resolveComparisonScope,
  type ComparisonExperimentParams,
} from "../../../comparison-responses";
import { readBenchmarkCommand } from "../../../mutation-responses";

type Context = { params: Promise<ComparisonExperimentParams> };

export async function GET(request: Request, { params }: Context) {
  try {
    const path = await params;
    const experimentId = benchmarkComparisonIdSchema.safeParse(path.experimentId);
    const query = benchmarkComparisonExportListQuerySchema.safeParse(comparisonQuery(request));
    if (!experimentId.success || !query.success) {
      return comparisonBadRequest("Provide a valid experiment and export cursor.");
    }
    const context = await resolveComparisonScope(path, request);
    if (!context.ok) return context.response;
    const exports = await listBenchmarkComparisonExports(
      { ...context.scope, experimentId: experimentId.data },
      query.data,
    );
    return Response.json(exports, { headers });
  } catch (error) {
    return comparisonFailure(error, "Could not load benchmark exports.");
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const path = await params;
    const experimentId = benchmarkComparisonIdSchema.safeParse(path.experimentId);
    if (!experimentId.success) return comparisonBadRequest("Provide a valid experiment.");
    const context = await resolveComparisonScope(path, request);
    if (!context.ok) return context.response;
    const command = await readBenchmarkCommand(
      request,
      benchmarkComparisonExportRequestSchema,
      "Provide a valid export request ID.",
      1024,
    );
    if (!command.ok) return command.response;
    const receipt = await createBenchmarkComparisonExport(
      { ...context.scope, experimentId: experimentId.data },
      command.data.requestId,
    );
    return Response.json(receipt, { status: 201, headers });
  } catch (error) {
    return comparisonFailure(error, "Could not create the benchmark export.");
  }
}
