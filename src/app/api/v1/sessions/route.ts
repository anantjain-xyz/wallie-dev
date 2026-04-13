import { NextRequest, NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api-keys/auth";

/**
 * GET /api/v1/sessions — List sessions for the workspace.
 *
 * Query parameters:
 *   phase    — Filter by phase (product, design, engineering, review, land, monitor)
 *   status   — Filter by phase_status
 *   limit    — Max results (default 50, max 100)
 *   offset   — Pagination offset (default 0)
 *
 * Authentication: Bearer <workspace_api_key>
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Invalid or missing API key. Use Authorization: Bearer wk_<key>" },
      { status: 401 },
    );
  }

  const { searchParams } = request.nextUrl;
  const phase = searchParams.get("phase");
  const status = searchParams.get("status");
  const limitParam = Number(searchParams.get("limit") ?? 50);
  const offsetParam = Number(searchParams.get("offset") ?? 0);
  const limit = Math.min(Math.max(1, limitParam), 100);
  const offset = Math.max(0, offsetParam);

  const admin = createSupabaseAdminClient();
  let query = admin
    .from("sessions")
    .select(
      "id, number, title, phase, phase_status, current_artifact_version, rejection_count, created_at, updated_at, archived_at",
      { count: "exact" },
    )
    .eq("workspace_id", auth.workspaceId)
    .order("number", { ascending: false })
    .range(offset, offset + limit - 1);

  if (phase) {
    query = query.eq(
      "phase",
      phase as "product" | "design" | "engineering" | "review" | "land" | "monitor",
    );
  }
  if (status) {
    query = query.eq(
      "phase_status",
      status as "agent_generating" | "awaiting_review" | "approved" | "rejected" | "escalated",
    );
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const sessions = (data ?? []).map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    phase: row.phase,
    phaseStatus: row.phase_status,
    currentArtifactVersion: row.current_artifact_version,
    rejectionCount: row.rejection_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }));

  return NextResponse.json({
    sessions,
    total: count ?? sessions.length,
    limit,
    offset,
  });
}
