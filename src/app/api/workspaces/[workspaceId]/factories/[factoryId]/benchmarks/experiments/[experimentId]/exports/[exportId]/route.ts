import { readBenchmarkComparisonExport } from "@/lib/factory-benchmarks/comparison";
import { benchmarkComparisonIdSchema } from "@/lib/factory-benchmarks/comparison-contracts";

import {
  comparisonBadRequest,
  comparisonDownload,
  comparisonFailure,
  resolveComparisonScope,
  type ComparisonExperimentParams,
} from "../../../../comparison-responses";

export async function GET(
  request: Request,
  { params }: { params: Promise<ComparisonExperimentParams & { exportId: string }> },
) {
  try {
    const path = await params;
    const experimentId = benchmarkComparisonIdSchema.safeParse(path.experimentId);
    const exportId = benchmarkComparisonIdSchema.safeParse(path.exportId);
    if (!experimentId.success || !exportId.success) {
      return comparisonBadRequest("Provide a valid experiment and export ID.");
    }
    const context = await resolveComparisonScope(path, request);
    if (!context.ok) return context.response;
    const body = await readBenchmarkComparisonExport(
      { ...context.scope, experimentId: experimentId.data },
      exportId.data,
    );
    return comparisonDownload(body, exportId.data);
  } catch (error) {
    return comparisonFailure(error, "Could not download the benchmark export manifest.");
  }
}
