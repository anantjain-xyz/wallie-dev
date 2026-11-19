import { NextResponse } from "next/server";
import { z } from "zod";

import type { SessionPhaseMutationResult } from "@/features/sessions/mutation-contracts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { cancelSessionCommand, readSessionCommand } from "@/lib/sessions/commands";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };
const cancellationIntent = z
  .object({ requestId: z.string().uuid(), expectedRunId: z.string().uuid() })
  .strict();

export async function POST(request: Request, { params }: Params) {
  const { sessionId } = await params;
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = cancellationIntent.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Select the exact run to stop." }, { status: 400 });
  }

  // Membership check via RLS: the server client can only read sessions the
  // current user can see through workspace_members. A non-member gets null → 404.
  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id, factory_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: "Could not read the session." }, { status: 500 });
  }
  if (!sessionRow) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const gated = await enforceRateLimit("phaseAction", `${sessionRow.workspace_id}:${user.id}`);
  if (gated.response) {
    return gated.response;
  }

  const member = await supabase
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", sessionRow.workspace_id)
    .eq("user_id", user.id)
    .eq("kind", "human")
    .eq("is_active", true)
    .maybeSingle();
  if (member.error) {
    return NextResponse.json({ error: "Could not verify workspace access." }, { status: 500 });
  }
  if (!member.data) {
    return NextResponse.json(
      { error: "Active workspace membership is required." },
      { status: 403 },
    );
  }

  const admin = createSupabaseAdminClient();
  try {
    await cancelSessionCommand({
      admin,
      command: { ...parsed.data, actorMemberId: member.data.id, factoryId: sessionRow.factory_id },
      sessionId: sessionRow.id,
      workspaceId: sessionRow.workspace_id,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "42501") {
      return NextResponse.json(
        { error: "You do not have access to stop this run." },
        { status: 403 },
      );
    }
    if (code === "PT404" || code === "P0002") {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    if (code === "P0003" || code === "P0005" || code === "40001" || code === "PT409") {
      return NextResponse.json(
        { error: "This run changed. Refresh before stopping it." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Could not stop the run." }, { status: 500 });
  }

  const state = await readSessionCommand(supabase, sessionRow.id, {
    workspaceId: sessionRow.workspace_id,
    factoryId: sessionRow.factory_id,
  });
  if (!state.ok) {
    if (state.code === "not_found") {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Could not reconcile the stopped session." },
      { status: 500 },
    );
  }

  return NextResponse.json<SessionPhaseMutationResult>(state.result);
}
