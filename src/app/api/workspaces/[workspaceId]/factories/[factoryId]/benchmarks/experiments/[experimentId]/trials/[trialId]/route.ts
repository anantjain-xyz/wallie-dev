import { readBenchmarkTrialEvidence } from "@/lib/factory-benchmarks/trial-evidence";
import { trialEvidenceIdParamsSchema } from "@/lib/factory-benchmarks/trial-evidence-contracts";
import { factoryResponseHeaders } from "@/lib/factories/route-context";

import {
  comparisonBadRequest,
  comparisonFailure,
  resolveComparisonScope,
} from "../../../../comparison-responses";

export const preferredRegion = "home";

type Params = { workspaceId: string; factoryId: string; experimentId: string; trialId: string };

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const path = trialEvidenceIdParamsSchema.safeParse(await params);
  if (!path.success) return comparisonBadRequest("Provide a valid benchmark trial.");
  try {
    const context = await resolveComparisonScope(path.data, request);
    if (!context.ok) return context.response;
    const detail = await readBenchmarkTrialEvidence({ ...context.scope, ...path.data });
    return Response.json(detail, { headers: factoryResponseHeaders });
  } catch (error) {
    return comparisonFailure(error, "Could not load the benchmark trial evidence.");
  }
}
