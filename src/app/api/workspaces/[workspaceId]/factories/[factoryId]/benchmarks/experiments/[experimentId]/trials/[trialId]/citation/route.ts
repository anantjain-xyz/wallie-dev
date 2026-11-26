import { readBenchmarkTrialCitation } from "@/lib/factory-benchmarks/trial-citation";
import {
  trialEvidenceCitationQuerySchema,
  trialEvidenceIdParamsSchema,
} from "@/lib/factory-benchmarks/trial-evidence-contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

import {
  comparisonBadRequest,
  comparisonFailure,
  comparisonQuery,
  resolveComparisonScope,
} from "../../../../../comparison-responses";

export const preferredRegion = "home";

type Params = { workspaceId: string; factoryId: string; experimentId: string; trialId: string };

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const path = trialEvidenceIdParamsSchema.safeParse(await params);
  const query = trialEvidenceCitationQuerySchema.safeParse(comparisonQuery(request));
  if (!path.success || !query.success)
    return comparisonBadRequest("Invalid trial citation request.");
  try {
    const context = await resolveComparisonScope(path.data, request);
    if (!context.ok) return context.response;
    const citation = await readBenchmarkTrialCitation(
      { ...context.scope, ...path.data },
      query.data,
    );
    return citation
      ? Response.json(citation, { headers })
      : Response.json({ error: "Cited source isn’t viewable here." }, { status: 404, headers });
  } catch (error) {
    return comparisonFailure(error, "Could not load the trial citation.");
  }
}
