import {
  analyticsExportReceiptSchema,
  parseAnalyticsExportRequest,
} from "@/features/factory-analytics/analytics-export-contracts";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { exportError, privateExportHeaders } from "@/lib/run-exports/access";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

function captureError(code: string) {
  switch (code) {
    case "PT404":
    case "42501":
      return exportError("Factory not found.", 404);
    case "PT409":
      return exportError("This export request was already used with different filters.", 409);
    case "PT410":
      return exportError("This export has expired. Create a new snapshot.", 410);
    case "PT422":
      return exportError("This cohort exceeds the export limit. Choose a shorter date range.", 422);
    case "PT429":
      return exportError("You have reached the active export limit. Try again later.", 429);
    case "22023":
      return exportError("Invalid analytics export filters.", 400);
    default:
      return exportError("Could not create the analytics export.", 500);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    if (new URL(request.url).search) return exportError("Unexpected export query.", 400);

    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;

    const body = await readBoundedJsonBody(request, 4096);
    if (!body.ok) {
      if (body.code === "request_too_large") return exportError("The request is too large.", 413);
      if (body.code === "unsupported_media_type") {
        return exportError("Send the request as application/json.", 415);
      }
      return exportError("Invalid analytics export request.", 400);
    }
    const input = parseAnalyticsExportRequest(body.body);
    if (!input) return exportError("Invalid analytics export filters.", 400);

    const { query, requestId } = input;
    const { data, error } = await context.access.supabase
      .rpc("create_factory_analytics_export", {
        p_workspace_id: context.workspaceId,
        p_factory_id: context.factoryId,
        p_from: query.from,
        p_to: query.to,
        p_request_id: requestId,
        p_dimension: query.dimension,
        p_environment: query.environment ?? undefined,
        p_compare_previous: query.comparison !== null,
      })
      .abortSignal(request.signal);
    if (error) return captureError(error.code);
    const receipt = analyticsExportReceiptSchema.safeParse(data);
    return receipt.success
      ? Response.json(receipt.data, { headers: privateExportHeaders })
      : exportError("Could not read the analytics export receipt.", 500);
  } catch {
    return exportError("Could not create the analytics export.", 500);
  }
}
