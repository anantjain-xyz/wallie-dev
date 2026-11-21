import { z } from "zod";

import { readBenchmarkComparisonExport } from "@/lib/factory-benchmarks/comparison";
import {
  benchmarkComparisonExportOrdinalSchema,
  benchmarkComparisonIdSchema,
} from "@/lib/factory-benchmarks/comparison-contracts";

import {
  comparisonBadRequest,
  comparisonDownload,
  comparisonFailure,
  resolveComparisonScope,
  type ComparisonExperimentParams,
} from "../../../../../../comparison-responses";

const exportSectionSchema = z.enum(["parts", "candidate-parts"]);

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<
      ComparisonExperimentParams & { exportId: string; section: string; part: string }
    >;
  },
) {
  try {
    const path = await params;
    const experimentId = benchmarkComparisonIdSchema.safeParse(path.experimentId);
    const exportId = benchmarkComparisonIdSchema.safeParse(path.exportId);
    const ordinal = benchmarkComparisonExportOrdinalSchema.safeParse(path.part);
    const section = exportSectionSchema.safeParse(path.section);
    if (!experimentId.success || !exportId.success || !ordinal.success || !section.success) {
      return comparisonBadRequest("Provide a valid experiment, export ID, and part number.");
    }
    const part = {
      ordinal: ordinal.data,
      kind: section.data === "parts" ? "trials" : "candidates",
    } as const;
    const context = await resolveComparisonScope(path, request);
    if (!context.ok) return context.response;
    const body = await readBenchmarkComparisonExport(
      { ...context.scope, experimentId: experimentId.data },
      exportId.data,
      part,
    );
    return comparisonDownload(body, exportId.data, part);
  } catch (error) {
    return comparisonFailure(error, "Could not download the benchmark export part.");
  }
}
