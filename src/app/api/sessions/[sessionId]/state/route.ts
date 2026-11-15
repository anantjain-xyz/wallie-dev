import { NextResponse } from "next/server";

import type {
  SessionMutationErrorResponse,
  SessionPhaseMutationResult,
} from "@/features/sessions/mutation-contracts";
import {
  querySessionPhaseState,
  resolveSessionPhaseState,
} from "@/features/sessions/phase-state.server";
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

  const { data, error } = await querySessionPhaseState(supabase, sessionId).maybeSingle();

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
  const result = await resolveSessionPhaseState(supabase, data);
  if (!result) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: "mutation_failed", error: "Session stage not found" },
      { status: 500 },
    );
  }

  return NextResponse.json<SessionPhaseMutationResult>(result);
}
