import { NextResponse } from "next/server";

import type {
  SessionMutationErrorResponse,
  SessionPhaseMutationResult,
} from "@/features/sessions/mutation-contracts";
import { readSessionCommand } from "@/lib/sessions/commands";
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

  const state = await readSessionCommand(supabase, sessionId);
  if (!state.ok) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: state.code, error: state.error },
      { status: state.code === "not_found" ? 404 : 500 },
    );
  }

  return NextResponse.json<SessionPhaseMutationResult>(state.result);
}
