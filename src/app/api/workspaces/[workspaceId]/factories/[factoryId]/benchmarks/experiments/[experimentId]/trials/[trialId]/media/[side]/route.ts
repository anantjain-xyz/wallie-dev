import { readBenchmarkTrialMedia } from "@/lib/factory-benchmarks/trial-evidence";
import {
  trialEvidenceIdParamsSchema,
  trialEvidenceMediaSideSchema,
} from "@/lib/factory-benchmarks/trial-evidence-contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

import {
  comparisonBadRequest,
  comparisonFailure,
  resolveComparisonScope,
} from "../../../../../../comparison-responses";

export const preferredRegion = "home";

const paramsSchema = trialEvidenceIdParamsSchema.extend({ side: trialEvidenceMediaSideSchema });
type Params = {
  workspaceId: string;
  factoryId: string;
  experimentId: string;
  trialId: string;
  side: string;
};

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const path = paramsSchema.safeParse(await params);
  if (!path.success) return comparisonBadRequest("Provide a valid trial and evidence source.");
  try {
    const { side, ...ids } = path.data;
    const context = await resolveComparisonScope(ids, request);
    if (!context.ok) return context.response;
    const media = await readBenchmarkTrialMedia({ ...context.scope, ...ids }, side);
    return Response.json(media, { headers });
  } catch (error) {
    return comparisonFailure(error, "Could not load the trial browser evidence.");
  }
}
