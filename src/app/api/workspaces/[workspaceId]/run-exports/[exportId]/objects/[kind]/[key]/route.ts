import { z } from "zod";

import { authorizeRunExport, exportAttachmentHeaders, exportError } from "@/lib/run-exports/access";
import { readRunExportObject, runExportObjectSchema } from "@/lib/run-exports/storage";

type RouteContext = {
  params: Promise<{ workspaceId: string; exportId: string; kind: string; key: string }>;
};

const objectKey = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), key: z.string().regex(/^[1-9]\d{0,15}$/) }),
  z.object({ kind: z.literal("asset"), key: z.string().uuid() }),
]);

const objectFailureStatus = {
  missing: 404,
  inaccessible: 503,
  integrity_mismatch: 409,
  unavailable: 503,
};

export async function GET(request: Request, { params }: RouteContext) {
  const values = await params;
  const target = objectKey.safeParse(values);
  if (!target.success) return exportError("Invalid export object id.", 400);

  try {
    const access = await authorizeRunExport(values);
    if (!access.ok) return access.response;
    const { admin, exportId, workspaceId, getJob } = access;
    const job = await getJob(request.signal);
    if (!job) return exportError("Run export not found.", 404);
    if (job.status === "expired") return exportError("This export has expired.", 410);
    if (job.status !== "completed") return exportError("This export is not ready.", 409);

    const descriptor = await (async () => {
      if (target.data.kind === "page") {
        const firstOrdinal = Number(target.data.key);
        if (!Number.isSafeInteger(firstOrdinal)) return null;
        const { data, error } = await admin
          .from("run_export_pages")
          .select("first_ordinal, sha256, size_bytes")
          .eq("workspace_id", workspaceId)
          .eq("export_id", exportId)
          .eq("first_ordinal", firstOrdinal)
          .abortSignal(request.signal)
          .maybeSingle();
        if (error) throw error;
        return (
          data && {
            kind: "page" as const,
            firstOrdinal: data.first_ordinal,
            sha256: data.sha256,
            sizeBytes: data.size_bytes,
            contentType: "application/json",
          }
        );
      }

      const { data, error } = await admin
        .from("run_export_assets")
        .select("asset_id, sha256, size_bytes, content_type")
        .eq("workspace_id", workspaceId)
        .eq("export_id", exportId)
        .eq("asset_id", target.data.key)
        .abortSignal(request.signal)
        .maybeSingle();
      if (error) throw error;
      return (
        data && {
          kind: "asset" as const,
          assetId: data.asset_id,
          sha256: data.sha256,
          sizeBytes: data.size_bytes,
          contentType: data.content_type,
        }
      );
    })();
    if (!descriptor) return exportError("Export object not found.", 404);
    const parsed = runExportObjectSchema.safeParse(descriptor);
    if (!parsed.success) return exportError("The export object descriptor is invalid.", 409);
    const object = parsed.data;

    const file = await readRunExportObject({
      supabase: admin,
      workspaceId,
      exportId,
      object,
      signal: request.signal,
    });
    const refreshed = await getJob(request.signal);
    if (!refreshed) return exportError("Run export not found.", 404);
    if (refreshed.status !== "completed")
      return exportError("This export is no longer available.", 410);
    if (file.status !== "available") {
      return exportError("Export object is unavailable.", objectFailureStatus[file.status]);
    }

    const extension = object.contentType === "application/json" ? "json" : "txt";
    const name =
      object.kind === "page"
        ? `page-${object.firstOrdinal}.${extension}`
        : `asset-${object.assetId}.${extension}`;
    return new Response(file.bytes, {
      headers: exportAttachmentHeaders(name, object.contentType),
    });
  } catch {
    return exportError("Could not load the export object.", 500);
  }
}
