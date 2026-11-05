import { NextResponse } from "next/server";
import { z } from "zod";

import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import type { Tables } from "@/lib/supabase/database.types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };
type SyncSummary = Pick<
  Tables<"session_pr_sync">,
  | "session_id"
  | "current_epoch_id"
  | "desired_checkpoint_run_id"
  | "target_generation"
  | "status"
  | "observed_head_sha"
  | "observed_pr_head_sha"
  | "last_error_code"
>;
type EpochSummary = Pick<
  Tables<"session_pr_epochs">,
  | "id"
  | "epoch_number"
  | "repository_id"
  | "github_repository_id"
  | "repository_full_name"
  | "base_branch"
  | "branch_name"
  | "pr_number"
  | "pr_url"
  | "pr_state"
  | "is_draft"
>;
type StateResponse = { sync: SyncSummary | null; epoch: EpochSummary | null };
type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "invalid_state"
  | "mutation_failed";

const uuid = z.string().uuid();
const successorBody = z.object({ expectedEpochId: uuid, requestId: uuid }).strict();
const noStore = { "Cache-Control": "private, no-store" };

function failure(code: ErrorCode, error: string, status: number) {
  return NextResponse.json({ code, error }, { status, headers: noStore });
}

async function sessionForViewer(sessionId: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) return { response: failure("unauthorized", "Unauthorized", 401) };
  // Both this lookup and the synchronization reads use the viewer's RLS client.
  const { data: session, error } = await supabase
    .from("sessions")
    .select("id, workspace_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) return { response: failure("mutation_failed", "Session lookup failed.", 500) };
  if (!session) return { response: failure("not_found", "Session not found", 404) };
  return { supabase, user, session };
}

/** Expose synchronization facts without treating a cached PR link as readiness. */
export async function GET(_request: Request, { params }: Params) {
  const { sessionId } = await params;
  if (!uuid.safeParse(sessionId).success)
    return failure("invalid_input", "Invalid session identity.", 400);
  const viewer = await sessionForViewer(sessionId);
  if (viewer.response) return viewer.response;
  const { supabase, session } = viewer;
  const { data: sync, error } = await supabase
    .from("session_pr_sync")
    .select(
      "session_id, current_epoch_id, desired_checkpoint_run_id, target_generation, status, observed_head_sha, observed_pr_head_sha, last_error_code",
    )
    .eq("session_id", session.id)
    .eq("workspace_id", session.workspace_id)
    .maybeSingle();
  if (error)
    return failure("mutation_failed", "Pull request synchronization state is unavailable.", 500);
  if (!sync?.current_epoch_id)
    return NextResponse.json<StateResponse>({ sync, epoch: null }, { headers: noStore });
  const { data: epoch, error: epochError } = await supabase
    .from("session_pr_epochs")
    .select(
      "id, epoch_number, repository_id, github_repository_id, repository_full_name, base_branch, branch_name, pr_number, pr_url, pr_state, is_draft",
    )
    .eq("id", sync.current_epoch_id)
    .eq("session_id", session.id)
    .eq("workspace_id", session.workspace_id)
    .maybeSingle();
  if (epochError || !epoch)
    return failure("mutation_failed", "Pull request synchronization state is unavailable.", 500);
  return NextResponse.json<StateResponse>({ sync, epoch }, { headers: noStore });
}

/** A terminal PR needs an explicit, idempotent human request for a new epoch. */
export async function POST(request: Request, { params }: Params) {
  const { sessionId } = await params;
  if (!uuid.safeParse(sessionId).success)
    return failure("invalid_input", "Invalid session identity.", 400);
  const viewer = await sessionForViewer(sessionId);
  if (viewer.response) return viewer.response;
  const parsed = successorBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failure("invalid_input", "Invalid successor request.", 400);
  const { supabase, user, session } = viewer;
  const { data: member, error: memberError } = await supabase
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", session.workspace_id)
    .eq("user_id", user.id)
    .eq("kind", "human")
    .eq("is_active", true)
    .maybeSingle();
  if (memberError) return failure("mutation_failed", "Membership lookup failed.", 500);
  if (!member) return failure("forbidden", "An active workspace member is required.", 403);
  const gated = await enforceRateLimit("phaseAction", `${session.workspace_id}:${user.id}`);
  if (gated.response) {
    const headers = new Headers(gated.response.headers);
    headers.set("Cache-Control", "private, no-store");
    return NextResponse.json(
      { code: "rate_limited", error: "Rate limit exceeded. Please retry later." },
      { status: 429, headers },
    );
  }
  const { data: epochId, error } = await createSupabaseAdminClient().rpc(
    "authorize_session_pr_successor",
    {
      p_actor_user_id: user.id,
      p_session_id: session.id,
      p_expected_epoch_id: parsed.data.expectedEpochId,
      p_request_id: parsed.data.requestId,
    },
  );
  if (error) {
    if (error.code === "42501")
      return failure("forbidden", "An active workspace member is required.", 403);
    if (error.code === "P0002") return failure("not_found", "Session not found", 404);
    if (["55000", "23514", "23505"].includes(error.code))
      return failure(
        "invalid_state",
        "The pull request changed or does not require a successor.",
        409,
      );
    return failure("mutation_failed", "The successor request could not be recorded.", 500);
  }
  if (!epochId)
    return failure(
      "invalid_state",
      "The pull request changed or does not require a successor.",
      409,
    );
  return NextResponse.json({ epochId }, { status: 202, headers: noStore });
}
