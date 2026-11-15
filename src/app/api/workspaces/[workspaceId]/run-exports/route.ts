import { z } from "zod";

import { exportError, privateExportHeaders, summarizeRunExport } from "@/lib/run-exports/access";
import { runExportRequestSchema } from "@/lib/run-exports/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  if (!z.string().uuid().safeParse(workspaceId).success)
    return exportError("Invalid workspace id.", 400);

  try {
    const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
    if (!access.ok) return exportError(access.error, access.status);

    const { data, error } = await createSupabaseAdminClient().rpc("list_run_exports", {
      p_workspace_id: access.context.workspace.id,
      p_user_id: access.context.user.id,
      p_limit: 10,
    });
    if (error?.code === "42501") return exportError("Workspace admin access is required.", 403);
    if (error) throw error;

    return Response.json(
      { exports: (data ?? []).map(summarizeRunExport) },
      { headers: privateExportHeaders },
    );
  } catch {
    return exportError("Could not load run exports.", 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  if (!z.string().uuid().safeParse(workspaceId).success)
    return exportError("Invalid workspace id.", 400);

  try {
    const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
    if (!access.ok) return exportError(access.error, access.status);

    const body = runExportRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return exportError("Invalid run export request.", 400);

    const { data, error } = await createSupabaseAdminClient().rpc("request_run_export", {
      p_workspace_id: access.context.workspace.id,
      p_requested_by: access.context.user.id,
      p_request_id: body.data.requestId,
    });
    if (error?.code === "42501") return exportError("Workspace admin access is required.", 403);
    if (error?.code === "P0002") return exportError("Workspace not found.", 404);
    if (error?.code === "55000") return exportError("An export is already in progress.", 409);
    if (error || !data) return exportError("Could not request an export.", 500);

    const job = summarizeRunExport(data);
    return Response.json(
      { export: job },
      {
        status: job.status === "queued" || job.status === "running" ? 202 : 200,
        headers: privateExportHeaders,
      },
    );
  } catch {
    return exportError("Could not request an export.", 500);
  }
}
