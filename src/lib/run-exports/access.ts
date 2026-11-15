import "server-only";

import { z } from "zod";

import { runExportSummarySchema } from "@/lib/run-exports/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const privateExportHeaders = { "Cache-Control": "private, no-store" };
const exportParams = z.object({ workspaceId: z.string().uuid(), exportId: z.string().uuid() });

export function exportError(error: string, status: number) {
  return Response.json({ error }, { status, headers: privateExportHeaders });
}

export function exportAttachmentHeaders(filename: string, contentType: string) {
  return {
    ...privateExportHeaders,
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  };
}

export function summarizeRunExport(row: Tables<"run_exports">) {
  return runExportSummarySchema.parse({
    id: row.id,
    requestedAt: row.requested_at,
    snapshotAt: row.snapshot_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    status: row.status,
    itemCount: row.item_count,
    processedCount: row.next_ordinal - 1,
  });
}

export async function authorizeRunExport(params: { workspaceId: string; exportId: string }) {
  const target = exportParams.safeParse(params);
  if (!target.success) {
    return { ok: false, response: exportError("Invalid run export request.", 400) } as const;
  }
  const access = await requireWorkspaceAccessById(target.data.workspaceId, {
    includeSessionId: true,
    requireManager: true,
  });
  if (!access.ok) {
    return { ok: false, response: exportError(access.error, access.status) } as const;
  }
  const workspaceId = access.context.workspace.id;
  const userId = access.context.user.id;
  const session = z.string().uuid().safeParse(access.context.user.sessionId);
  if (!session.success) {
    return {
      ok: false,
      response: exportError("Sign in again to download run exports.", 401),
    } as const;
  }
  const sessionId = session.data;
  const exportId = target.data.exportId;
  const admin = createSupabaseAdminClient();

  async function getJob(signal: AbortSignal) {
    const { data, error } = await admin
      .rpc("get_run_export_access", {
        p_workspace_id: workspaceId,
        p_export_id: exportId,
        p_user_id: userId,
        p_session_id: sessionId,
      })
      .abortSignal(signal)
      .maybeSingle();
    if (error) throw error;
    return data?.id === exportId ? summarizeRunExport(data) : null;
  }

  return { ok: true, admin, workspaceId, exportId, getJob } as const;
}
