import {
  RunTranscriptCursorError,
  RunTranscriptResetError,
} from "@/features/wallie/run-transcript";
import { runTranscriptQuerySchema } from "@/features/wallie/run-transcript-contracts";
import { readBenchmarkTrialTranscript } from "@/lib/factory-benchmarks/trial-evidence";
import { trialEvidenceIdParamsSchema } from "@/lib/factory-benchmarks/trial-evidence-contracts";
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
  const query = runTranscriptQuerySchema.safeParse(comparisonQuery(request));
  if (!path.success || !query.success)
    return comparisonBadRequest("Invalid trial transcript request.");
  try {
    const context = await resolveComparisonScope(path.data, request);
    if (!context.ok) return context.response;
    const page = await readBenchmarkTrialTranscript({ ...context.scope, ...path.data }, query.data);
    if (!page)
      return Response.json(
        { error: "The trial transcript is unavailable." },
        { status: 404, headers },
      );
    return Response.json(page, { headers });
  } catch (error) {
    if (error instanceof RunTranscriptCursorError)
      return comparisonBadRequest("Invalid run transcript cursor.");
    if (error instanceof RunTranscriptResetError)
      return Response.json(
        { error: "Transcript source changed. Refresh the transcript.", code: "transcript_reset" },
        { status: 409, headers },
      );
    return comparisonFailure(error, "Could not load the benchmark trial transcript.");
  }
}
