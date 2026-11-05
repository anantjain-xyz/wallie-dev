import { NextResponse } from "next/server";
import { z } from "zod";

import type {
  SessionMutationErrorCode,
  SessionMutationErrorResponse,
  SessionPhaseMutationResult,
} from "@/features/sessions/mutation-contracts";
import { handleApproval, handleRejection } from "@/lib/pipeline/processor";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withServerTiming, type ServerTimingCollector } from "@/lib/server-timing";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };

const FeedbackSubmissionSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedReviewRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    selectedThreadIds: z
      .array(z.string().uuid())
      .max(20, "Select at most 20 inline threads.")
      .refine((ids) => new Set(ids).size === ids.length, "Select each inline thread only once."),
  })
  .strict();

const PhaseActionBodySchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    artifactId: z.string().uuid(),
    stageId: z.string().uuid(),
    feedbackText: z
      .string()
      .refine(
        (text) => Array.from(text).length <= 4000,
        "Whole-stage feedback must be at most 4,000 characters.",
      )
      .optional(),
    feedbackSubmission: FeedbackSubmissionSchema.optional(),
    version: z.number().int().nonnegative().max(2147483647),
  })
  .strict()
  .refine((body) => !body.feedbackSubmission || body.action === "reject", {
    message: "Feedback submissions can only request changes.",
  });

function errorResponse(code: SessionMutationErrorCode, error: string, status: number) {
  return NextResponse.json<SessionMutationErrorResponse>({ code, error }, { status });
}

export async function POST(request: Request, { params }: Params) {
  const { sessionId } = await params;
  return withServerTiming("session.phase-action", { sessionId }, async (timing) => {
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

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return errorResponse("invalid_input", "Invalid JSON body", 400);
    }

    const parsed = PhaseActionBodySchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(
        "invalid_input",
        parsed.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
    }
    const body = parsed.data;

    // Membership check via RLS: the server client can only read sessions the
    // current user can see through workspace_members. If the caller is not a
    // member, this returns null and we 404.
    const { data: sessionRow, error: sessionError } = await timing.segment("lookup", () =>
      supabase
        .from("sessions")
        .select("id, workspace_id, phase_status, current_stage_id, archived_at")
        .eq("id", sessionId)
        .maybeSingle(),
    );

    if (sessionError) {
      return errorResponse("mutation_failed", sessionError.message, 500);
    }
    if (!sessionRow) {
      return errorResponse("not_found", "Session not found", 404);
    }

    // An archived session is frozen: approving/rejecting must not advance or
    // re-run it. Block before any RPC mutation.
    const immutableSubmission = body.action === "reject" && body.feedbackSubmission;
    if (sessionRow.archived_at && !immutableSubmission) {
      return errorResponse("archived", "Session is archived.", 409);
    }

    if (sessionRow.phase_status !== "awaiting_review" && !immutableSubmission) {
      return errorResponse("invalid_state", "Session is not awaiting review.", 409);
    }

    const [gated, { data: memberRow }] = await Promise.all([
      timing.segment("rate-limit", () =>
        enforceRateLimit("phaseAction", `${sessionRow.workspace_id}:${user.id}`),
      ),
      timing.segment("authorization", () =>
        supabase
          .from("workspace_members")
          .select("id, role")
          .eq("workspace_id", sessionRow.workspace_id)
          .eq("user_id", user.id)
          .eq("kind", "human")
          .eq("is_active", true)
          .maybeSingle(),
      ),
    ]);

    if (gated.response) {
      return NextResponse.json(
        {
          code: "rate_limited" as const,
          error: "Rate limit exceeded. Please retry later.",
          retryAfterSeconds: gated.result.retryAfterSeconds,
        },
        { headers: gated.response.headers, status: 429 },
      );
    }

    if (!memberRow) {
      return errorResponse("forbidden", "Not a member of this workspace.", 403);
    }

    if (body.action === "approve") {
      // Belt-and-suspenders authz check: the RPC enforces this too, but doing it
      // here gives a clearer 403 ("not in approver list") instead of the RPC's
      // generic CAS-miss "stale or already reviewed" message.
      const authError = await timing.segment("authorization.approver", () =>
        checkApproverAuthorization(
          sessionRow.workspace_id,
          sessionRow.current_stage_id,
          memberRow.id,
          memberRow.role,
        ),
      );
      if (authError) {
        return errorResponse("forbidden", authError, 403);
      }

      const result = await timing.segment("mutation", () =>
        handleApproval({
          approverMemberId: memberRow.id,
          expectedArtifactId: body.artifactId,
          expectedStageId: body.stageId,
          expectedWorkspaceId: sessionRow.workspace_id,
          sessionId: sessionRow.id,
          version: body.version,
        }),
      );
      if (!result.success) {
        return errorResponse("stale_version", result.error ?? "Approval failed", 409);
      }
      return loadMutationResult(supabase, timing, sessionRow.id);
    }

    if (body.action === "reject") {
      const feedbackText = (body.feedbackText ?? "").trim();
      if (!feedbackText && !body.feedbackSubmission?.selectedThreadIds.length) {
        return errorResponse("invalid_input", "Feedback is required", 400);
      }
      const result = await timing.segment("mutation", () =>
        handleRejection({
          expectedArtifactId: body.artifactId,
          expectedStageId: body.stageId,
          expectedWorkspaceId: sessionRow.workspace_id,
          feedbackText,
          ...(body.feedbackSubmission ? { feedbackSubmission: body.feedbackSubmission } : {}),
          requestedByMemberId: memberRow.id,
          sessionId: sessionRow.id,
          version: body.version,
        }),
      );
      if (!result.success) {
        if (body.feedbackSubmission) return feedbackSubmissionError(result.errorCode, result.error);
        const code = isStaleVersionError(result.error) ? "stale_version" : "mutation_conflict";
        return errorResponse(code, result.error ?? "Rejection failed", 409);
      }
      return loadMutationResult(
        supabase,
        timing,
        sessionRow.id,
        result.feedbackBatchId && result.jobId && result.revisionRunId
          ? {
              feedbackBatchId: result.feedbackBatchId,
              revisionJobId: result.jobId,
              revisionRunId: result.revisionRunId,
              revisionGeneration: result.jobId,
            }
          : undefined,
      );
    }

    return errorResponse("invalid_input", "Unknown action", 400);
  });
}

/** Database batch errors use fixed messages, never echoed comment or anchor text. */
function feedbackSubmissionError(code: string | undefined, message: string | undefined) {
  if (code === "40001" || code === "55000")
    return errorResponse(
      "stale_version",
      "This artifact or review changed. Refresh comments before submitting again.",
      409,
    );
  if (code === "23505")
    return errorResponse(
      "mutation_conflict",
      "This request was already submitted with different feedback. Refresh the review.",
      409,
    );
  if (code === "42501")
    return errorResponse("forbidden", "Active human workspace membership is required.", 403);
  if (code === "22001")
    return errorResponse(
      "invalid_input",
      message ?? "Feedback batch exceeds its limits. Select fewer threads or shorten your note.",
      400,
    );
  if (["22023", "22P02", "23514", "23503"].includes(code ?? ""))
    return errorResponse(
      "invalid_input",
      "Selected feedback is invalid or unavailable for this artifact. Refresh comments and select them again.",
      400,
    );
  return errorResponse(
    "mutation_failed",
    "Could not submit feedback. Your draft is retained; retry with the same request.",
    500,
  );
}

function isStaleVersionError(error: string | undefined) {
  return error?.includes("Version mismatch") || error?.includes("raced with another update");
}

async function loadMutationResult(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  timing: ServerTimingCollector,
  sessionId: string,
  feedbackReceipt?: {
    feedbackBatchId: string;
    revisionJobId: string;
    revisionRunId: string;
    revisionGeneration: string;
  },
) {
  const { data, error } = await timing.segment("mutation.result", () =>
    supabase
      .from("sessions")
      .select(
        "id, archived_at, phase_status, current_stage_id, current_artifact_id, current_artifact_version, rejection_count, updated_at, currentStage:pipeline_stages!sessions_current_stage_id_fkey(id, description, name, position, slug)",
      )
      .eq("id", sessionId)
      .single(),
  );

  if (error || !data || !data.currentStage) {
    if (feedbackReceipt) {
      return NextResponse.json(
        { ...feedbackReceipt, reconciliationRequired: true },
        { status: 202 },
      );
    }
    return errorResponse(
      "mutation_failed",
      error?.message ?? "Wallie could not reconcile that session action.",
      500,
    );
  }

  return NextResponse.json<SessionPhaseMutationResult>({
    ...feedbackReceipt,
    archivedAt: data.archived_at,
    currentArtifactId: data.current_artifact_id ?? null,
    artifactVersion: data.current_artifact_version,
    currentStage: data.currentStage,
    currentStageId: data.current_stage_id,
    id: data.id,
    phaseStatus: data.phase_status,
    rejectionCount: data.rejection_count,
    updatedAt: data.updated_at,
  });
}

async function checkApproverAuthorization(
  workspaceId: string,
  stageId: string,
  memberId: string,
  memberRole: string,
): Promise<string | null> {
  // Use the admin client to read the stage's approver list. RLS would also
  // allow this read for the current user, but using admin keeps a single code
  // path regardless of who the caller is.
  const admin = createSupabaseAdminClient();
  const { data: stage, error } = await admin
    .from("pipeline_stages")
    .select("anyone_can_approve, approver_member_ids, name")
    .eq("id", stageId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) return error.message;
  if (!stage) return "Stage not found.";

  if (stage.anyone_can_approve) return null;

  const approvers = stage.approver_member_ids ?? [];
  if (approvers.length > 0) {
    if (!approvers.includes(memberId)) {
      return `You are not authorized to approve the ${stage.name} stage.`;
    }
    return null;
  }

  // Empty list: fall back to workspace owners/admins.
  if (memberRole !== "owner" && memberRole !== "admin") {
    return `Only workspace owners and admins can approve the ${stage.name} stage (no approver list set).`;
  }
  return null;
}
