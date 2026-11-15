import { authorizeRunExport, exportAttachmentHeaders, exportError } from "@/lib/run-exports/access";

type RouteContext = { params: Promise<{ workspaceId: string; exportId: string }> };

const PAGE_INDEX_BATCH = 100;

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const access = await authorizeRunExport(await params);
    if (!access.ok) return access.response;
    const { admin, exportId, getJob, workspaceId } = access;
    const job = await getJob(request.signal);
    if (!job) return exportError("Run export not found.", 404);
    if (job.status === "expired") return exportError("This export has expired.", 410);
    if (job.status !== "completed") return exportError("This export is not ready.", 409);

    const encoder = new TextEncoder();
    const summary = JSON.stringify({
      version: 1,
      exportId,
      workspaceId,
      snapshotAt: job.snapshotAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
      itemCount: job.itemCount,
    });
    const path = `/api/workspaces/${workspaceId}/run-exports/${exportId}/objects`;
    let expectedOrdinal = 1;
    let started = false;
    const manifest = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const firstBatch = !started;
        if (firstBatch) {
          started = true;
          controller.enqueue(encoder.encode(summary.slice(0, -1) + ',"pages":['));
        }
        request.signal.throwIfAborted();
        if (expectedOrdinal > job.itemCount) {
          if ((await getJob(request.signal))?.status !== "completed") {
            throw new Error("Run export access expired.");
          }
          controller.enqueue(encoder.encode("]}\n"));
          controller.close();
          return;
        }

        const { data: pages, error } = await admin
          .from("run_export_pages")
          .select("first_ordinal, last_ordinal, sha256, size_bytes")
          .eq("workspace_id", workspaceId)
          .eq("export_id", exportId)
          .gte("first_ordinal", expectedOrdinal)
          .order("first_ordinal")
          .limit(PAGE_INDEX_BATCH)
          .abortSignal(request.signal);
        if (error || !pages?.length) throw new Error("The export manifest index is incomplete.");
        if ((await getJob(request.signal))?.status !== "completed") {
          throw new Error("Run export access expired.");
        }

        const descriptors = pages.map((page) => {
          if (
            page.first_ordinal !== expectedOrdinal ||
            page.last_ordinal < page.first_ordinal ||
            page.last_ordinal > job.itemCount
          ) {
            throw new Error("The export manifest index is incomplete.");
          }
          expectedOrdinal = page.last_ordinal + 1;
          return JSON.stringify({
            firstOrdinal: page.first_ordinal,
            lastOrdinal: page.last_ordinal,
            sha256: page.sha256,
            sizeBytes: page.size_bytes,
            url: `${path}/page/${page.first_ordinal}`,
          });
        });
        controller.enqueue(encoder.encode((firstBatch ? "" : ",") + descriptors.join(",")));
      },
    });
    return new Response(manifest, {
      headers: exportAttachmentHeaders(`wallie-export-${exportId}.json`, "application/json"),
    });
  } catch {
    return exportError("Could not load the run export manifest.", 500);
  }
}
