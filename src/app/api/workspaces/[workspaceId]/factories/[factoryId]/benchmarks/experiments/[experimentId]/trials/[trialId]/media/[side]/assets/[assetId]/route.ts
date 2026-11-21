import { benchmarkComparisonIdSchema } from "@/lib/factory-benchmarks/comparison-contracts";
import { readBenchmarkTrialMediaAsset } from "@/lib/factory-benchmarks/trial-evidence";
import {
  trialEvidenceIdParamsSchema,
  trialEvidenceMediaSideSchema,
} from "@/lib/factory-benchmarks/trial-evidence-contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

import {
  comparisonBadRequest,
  comparisonFailure,
  resolveComparisonScope,
} from "../../../../../../../../comparison-responses";

export const preferredRegion = "home";

const paramsSchema = trialEvidenceIdParamsSchema.extend({
  side: trialEvidenceMediaSideSchema,
  assetId: benchmarkComparisonIdSchema,
});
type Params = {
  workspaceId: string;
  factoryId: string;
  experimentId: string;
  trialId: string;
  side: string;
  assetId: string;
};

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const path = paramsSchema.safeParse(await params);
  if (!path.success) return comparisonBadRequest("Provide a valid trial evidence asset.");
  try {
    const { assetId, side, ...ids } = path.data;
    const context = await resolveComparisonScope(ids, request);
    if (!context.ok) return context.response;
    const asset = await readBenchmarkTrialMediaAsset({ ...context.scope, ...ids }, side, assetId);
    if (!asset || asset.result.status === "viewer_unavailable") {
      return Response.json(
        { error: "Trial evidence asset unavailable." },
        { status: 404, headers },
      );
    }
    if (asset.result.status === "withheld") {
      return Response.json(
        { error: "Trial evidence asset unavailable.", availability: asset.result.availability },
        { status: 410, headers },
      );
    }
    if (asset.result.status !== "available") {
      return Response.json(
        { error: "Trial evidence could not be verified." },
        { status: 409, headers },
      );
    }
    const extension = asset.kind === "video" ? ".webm" : ".png";
    const filename = 'attachment; filename="evidence-' + assetId + extension + '"';
    return new Response(asset.result.bytes, {
      headers: {
        ...headers,
        "Content-Type": asset.contentType,
        "Content-Disposition": filename,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return comparisonFailure(error, "Could not load the trial evidence asset.");
  }
}
