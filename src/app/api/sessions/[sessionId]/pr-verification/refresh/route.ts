import { NextResponse } from "next/server";

import {
  loadReviewContext,
  reviewErrorResponse,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };

/** The caller selects a session, never a repository, installation, or PR. */
export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const context = await loadReviewContext(sessionId);
    if (context.session.archived_at)
      return NextResponse.json(
        { error: "Archived sessions cannot be refreshed." },
        { status: 409 },
      );
    const { data, error } = await createSupabaseAdminClient().rpc("enqueue_session_pr_refresh", {
      p_workspace_id: context.session.workspace_id,
      p_session_id: context.session.id,
    });
    if (error) throw error;
    if (!data)
      return NextResponse.json(
        { error: "A current code delivery policy and canonical PR are required." },
        { status: 409 },
      );
    return NextResponse.json(
      { queued: true },
      { status: 202, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
