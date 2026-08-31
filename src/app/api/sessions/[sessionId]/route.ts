import { NextResponse } from "next/server";
import { z } from "zod";

import {
  normalizeUpdateSessionTitlePayload,
  updateSessionTitlePayloadSchema,
} from "@/features/sessions/update-title";
import type {
  SessionMutationErrorCode,
  SessionMutationErrorResponse,
  SessionTitleMutationResult,
} from "@/features/sessions/mutation-contracts";
import { withServerTiming } from "@/lib/server-timing";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };

const sessionIdSchema = z.string().uuid("Session id is invalid.");

function errorResponse(code: SessionMutationErrorCode, error: string, status: number) {
  return NextResponse.json<SessionMutationErrorResponse>({ code, error }, { status });
}

export async function PATCH(request: Request, { params }: Params) {
  const { sessionId } = await params;
  return withServerTiming("session.update-title", { sessionId }, async (timing) => {
    const parsedSessionId = sessionIdSchema.safeParse(sessionId);

    if (!parsedSessionId.success) {
      return errorResponse("invalid_input", "Session id is invalid.", 400);
    }

    const payload = await request.json().catch(() => null);
    const parsedPayload = updateSessionTitlePayloadSchema.safeParse(payload);

    if (!parsedPayload.success) {
      const firstIssue = parsedPayload.error.issues[0];

      return errorResponse(
        "invalid_input",
        firstIssue?.message ?? "Session title input is invalid.",
        400,
      );
    }

    const normalized = normalizeUpdateSessionTitlePayload(parsedPayload.data);
    const { supabase, user } = await timing.segment("auth", async () => {
      const authenticatedClient = await createSupabaseServerClient();
      return {
        supabase: authenticatedClient,
        user: await getSupabaseUserOrNull(authenticatedClient),
      };
    });

    if (!user) {
      return errorResponse("unauthorized", "Unauthorized", 401);
    }

    const { data: sessionRow, error: sessionError } = await timing.segment("lookup", () =>
      supabase
        .from("sessions")
        .select("id, workspace_id")
        .eq("id", parsedSessionId.data)
        .maybeSingle(),
    );

    if (sessionError) {
      return errorResponse("mutation_failed", sessionError.message, 500);
    }

    const authorized = await timing.segment("authorization", () => Boolean(sessionRow));
    if (!authorized || !sessionRow) {
      return errorResponse("not_found", "Session not found", 404);
    }

    const { data: updatedRow, error: updateError } = await timing.segment("mutation", () =>
      supabase
        .from("sessions")
        .update({ title: normalized.title })
        .eq("id", sessionRow.id)
        .eq("workspace_id", sessionRow.workspace_id)
        .select("id, title, updated_at")
        .single(),
    );

    if (updateError || !updatedRow) {
      return errorResponse(
        "mutation_failed",
        updateError?.message ?? "Wallie could not update that session title.",
        500,
      );
    }

    return NextResponse.json<SessionTitleMutationResult>({
      id: updatedRow.id,
      title: updatedRow.title,
      updatedAt: updatedRow.updated_at,
    });
  });
}
