import { z } from "zod";

import { analyticsExportFormatSchema } from "@/features/factory-analytics/analytics-export-contracts";
import {
  parseAnalyticsExportSnapshot,
  serializeAnalyticsExportCsv,
} from "@/features/factory-analytics/analytics-export-csv";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { exportAttachmentHeaders, exportError } from "@/lib/run-exports/access";

type Context = { params: Promise<{ workspaceId: string; factoryId: string; exportId: string }> };
const exportIdSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

export async function GET(request: Request, { params }: Context) {
  try {
    const target = await params;
    const exportId = exportIdSchema.safeParse(target.exportId);
    const search = new URL(request.url).searchParams;
    const formats = search.getAll("format");
    const format = analyticsExportFormatSchema.safeParse(formats[0]);
    if (!exportId.success || !format.success || formats.length !== 1 || search.size !== 1) {
      return exportError("Provide an export ID and a CSV or JSON format.", 400);
    }

    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;

    const { data, error } = await context.access.supabase
      .rpc("read_factory_analytics_export", {
        p_workspace_id: context.workspaceId,
        p_factory_id: context.factoryId,
        p_export_id: exportId.data,
      })
      .abortSignal(request.signal);
    if (error?.code === "PT404" || error?.code === "42501" || (!error && data == null)) {
      return exportError("Analytics export not found.", 404);
    }
    if (error || typeof data !== "string") {
      return exportError("Could not read the analytics export.", 500);
    }
    const snapshot = parseAnalyticsExportSnapshot(data, {
      exportId: exportId.data,
      workspaceId: context.workspaceId,
      factoryId: context.factoryId,
    });
    if (!snapshot) return exportError("Could not read the analytics export.", 500);

    const filename = "wallie-analytics-" + exportId.data + "." + format.data;
    if (format.data === "json") {
      return new Response(data, {
        headers: exportAttachmentHeaders(filename, "application/json; charset=utf-8"),
      });
    }
    const csv = serializeAnalyticsExportCsv(snapshot);
    if (!csv) return exportError("This snapshot is too large for CSV. Download JSON instead.", 422);
    return new Response(csv, {
      headers: exportAttachmentHeaders(filename, "text/csv; charset=utf-8"),
    });
  } catch {
    return exportError("Could not read the analytics export.", 500);
  }
}
