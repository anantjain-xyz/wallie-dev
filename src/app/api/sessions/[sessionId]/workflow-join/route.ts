import { NextResponse } from "next/server";
import { z } from "zod";

import { readAuthorizedJoinConflict } from "@/lib/factory-workflows/join-authorized-conflict";
import { maxJoinValidationSourceBytes } from "@/lib/factory-workflows/join-validation-source";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const intent = z.strictObject({
  requestId: uuid,
  expectedGeneration: z.number().int().safe().positive(),
  branchGroupId: uuid,
  expectedHeadRunId: uuid,
  selectedOutcomeIds: z
    .array(uuid)
    .min(1)
    .max(128)
    .refine((ids) => new Set(ids).size === ids.length),
});
const receipt = z.object({
  joinId: uuid,
  occurrenceId: uuid,
  jobId: uuid,
  runId: uuid,
  created: z.boolean(),
});
const conflictQuery = z.object({ joinId: uuid, runId: uuid });
const selection = z.object({
  manifest: z.object({ group_id: uuid, source_checkpoint_run_id: uuid }),
  joinStatus: z.enum([
    "pending",
    "ready",
    "required_blocked",
    "optional_failure",
    "paused",
    "canceled",
  ]),
  slots: z
    .array(
      z.object({
        slot: z.object({ branch_edge_id: z.string(), required: z.boolean() }),
        admissionBlocker: z.string().nullable(),
        outcome: z
          .object({
            outcome_id: uuid,
            outcome: z.enum(["succeeded", "failed", "canceled"]),
            checkpoint_run_id: uuid.nullable(),
          })
          .nullable(),
      }),
    )
    .max(128),
});
const generation = z.object({
  execution: z.object({ generation: z.number().int().safe().positive() }),
});
const joinCommandDeadlineMs = 8_000;

function respond(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function loadVisibleJoinRoot({ params }: Params) {
  const id = uuid.safeParse((await params).sessionId);
  if (!id.success) return { response: respond({ error: "Session not found." }, 404) };
  const userClient = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(userClient);
  if (!user) return { response: respond({ error: "Unauthorized." }, 401) };
  const { data, error } = await userClient
    .from("sessions")
    .select("id, workspace_id, factory_id")
    .eq("id", id.data)
    .maybeSingle();
  if (error) return { response: respond({ error: "Could not read the session." }, 500) };
  if (!data) return { response: respond({ error: "Session not found." }, 404) };
  return { userClient, userId: user.id, root: data };
}

export async function POST(request: Request, params: Params) {
  const visible = await loadVisibleJoinRoot(params);
  if (visible.response) return visible.response;
  const parsed = intent.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return respond(
      { error: "Provide the workflow generation, parent checkpoint, and branch outputs." },
      400,
    );
  }
  const { root, userId } = visible;
  const gated = await enforceRateLimit("phaseAction", `${root.workspace_id}:${userId}`);
  if (gated.response) return gated.response;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(joinCommandDeadlineMs)]);
  const { data, error } = await createSupabaseAdminClient()
    .rpc("enqueue_factory_workflow_join_for_user", {
      p_root_session_id: root.id,
      p_workspace_id: root.workspace_id,
      p_factory_id: root.factory_id,
      p_actor_user_id: userId,
      p_expected_generation: parsed.data.expectedGeneration,
      p_request_id: parsed.data.requestId,
      p_branch_group_id: parsed.data.branchGroupId,
      p_expected_head_run_id: parsed.data.expectedHeadRunId,
      p_selected_outcome_ids: parsed.data.selectedOutcomeIds,
    })
    .abortSignal(signal);
  switch (error?.code) {
    case undefined: {
      const admitted = receipt.safeParse(data);
      if (!admitted.success) return respond({ error: "Could not confirm the workflow join." }, 500);
      return respond(admitted.data, admitted.data.created ? 202 : 200);
    }
    case "42501":
      return respond({ error: "Workflow access or execution authority is unavailable." }, 403);
    case "P0002":
    case "PT404":
      return respond({ error: "Workflow branch group not found." }, 404);
    case "PT409":
    case "P0011":
      return respond(
        { error: "The workflow or selected source changed. Refresh before retrying." },
        409,
      );
    case "22023":
    case "PT422":
      return respond({ error: "The selected outputs cannot be joined." }, 422);
    default:
      return respond({ error: "Could not enqueue the workflow join." }, 500);
  }
}

async function readJoinSelection(
  root: { id: string; workspace_id: string; factory_id: string },
  branchGroupId: string,
  signal: AbortSignal,
) {
  const admin = createSupabaseAdminClient();
  const scope = {
    p_root_session_id: root.id,
    p_workspace_id: root.workspace_id,
    p_factory_id: root.factory_id,
  };
  const [group, workflow] = await Promise.all([
    admin
      .rpc("read_factory_workflow_branch_group", { ...scope, p_group_id: branchGroupId })
      .abortSignal(signal),
    admin.rpc("read_factory_workflow_execution", scope).abortSignal(signal),
  ]);
  if (group.error || workflow.error)
    return respond({ error: "Could not read the workflow branch group." }, 500);
  if (group.data === null || workflow.data === null)
    return respond({ error: "Workflow branch group not found." }, 404);
  const parsed = selection.safeParse(group.data);
  const owner = generation.safeParse(workflow.data);
  if (!parsed.success || !owner.success || parsed.data.manifest.group_id !== branchGroupId) {
    return respond({ error: "Could not verify the workflow branch group." }, 500);
  }
  return respond(
    {
      branchGroupId,
      expectedGeneration: owner.data.execution.generation,
      expectedHeadRunId: parsed.data.manifest.source_checkpoint_run_id,
      joinStatus: parsed.data.joinStatus,
      maxValidationPackBytes: maxJoinValidationSourceBytes,
      slots: parsed.data.slots.map(({ slot, outcome, admissionBlocker }) => ({
        branchEdgeId: slot.branch_edge_id,
        required: slot.required,
        status: outcome?.outcome ?? (admissionBlocker ? "blocked" : "pending"),
        outcomeId: outcome?.outcome_id ?? null,
        checkpointRunId: outcome?.checkpoint_run_id ?? null,
        admissionBlocker,
      })),
    },
    200,
  );
}

export async function GET(request: Request, params: Params) {
  const visible = await loadVisibleJoinRoot(params);
  if (visible.response) return visible.response;
  const search = new URL(request.url).searchParams;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(joinCommandDeadlineMs)]);
  if (search.has("branchGroupId")) {
    const branchGroupId = uuid.safeParse(search.get("branchGroupId"));
    if (!branchGroupId.success || search.has("joinId") || search.has("runId")) {
      return respond({ error: "Provide one exact workflow branch group." }, 400);
    }
    return readJoinSelection(visible.root, branchGroupId.data, signal);
  }
  const parsed = conflictQuery.safeParse({
    joinId: search.get("joinId"),
    runId: search.get("runId"),
  });
  if (!parsed.success) return respond({ error: "Workflow join conflict not found." }, 404);
  try {
    const conflict = await readAuthorizedJoinConflict({
      user: visible.userClient,
      storage: createSupabaseAdminClient(),
      scope: {
        workspaceId: visible.root.workspace_id,
        rootSessionId: visible.root.id,
        ...parsed.data,
      },
      signal,
    });
    if (!conflict) return respond({ error: "Workflow join conflict not found." }, 404);
    return respond(conflict, 200);
  } catch {
    return respond({ error: "Could not read the workflow join conflict." }, 500);
  }
}
