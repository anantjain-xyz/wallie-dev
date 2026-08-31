import { NextResponse } from "next/server";

import type {
  SessionMutationErrorResponse,
  SessionPhaseMutationResult,
} from "@/features/sessions/mutation-contracts";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { sessionId } = await params;
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: "unauthorized", error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { data, error } = await supabase
    .from("sessions")
    .select(
      "id, archived_at, phase_status, current_stage_id, current_artifact_version, rejection_count, updated_at, currentStage:pipeline_stages!sessions_current_stage_id_fkey(id, description, name, position, slug)",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: "mutation_failed", error: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: "not_found", error: "Session not found" },
      { status: 404 },
    );
  }
  if (!data.currentStage) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: "mutation_failed", error: "Session stage not found" },
      { status: 500 },
    );
  }

  return NextResponse.json<SessionPhaseMutationResult>({
    archivedAt: data.archived_at,
    artifactVersion: data.current_artifact_version,
    currentStage: data.currentStage,
    currentStageId: data.current_stage_id,
    id: data.id,
    phaseStatus: data.phase_status,
    rejectionCount: data.rejection_count,
    updatedAt: data.updated_at,
  });
}
