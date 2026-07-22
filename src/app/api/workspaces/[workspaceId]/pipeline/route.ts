import { NextResponse } from "next/server";
import { z } from "zod";

import { loadDefaultPipelineForWorkspace } from "@/lib/pipeline/stages";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type PipelineRewriteRpcResult = {
  blocking_session_numbers?: number[];
  duplicate_stage_ids?: string[];
  duplicate_stage_slugs?: string[];
  error_code?: string;
  invalid_approver_member_ids?: string[];
  ok?: boolean;
};

const stageInputSchema = z.object({
  // id is optional — present for existing stages that should be updated,
  // absent for newly added stages.
  id: z.string().uuid().nullish(),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  promptTemplateMd: z.string().max(20000).default(""),
  // Optional so older clients preserve an existing policy instead of
  // accidentally resetting it. Current editors always send this field.
  anyoneCanApprove: z.boolean().optional(),
  approverMemberIds: z.array(z.string().uuid()).default([]),
});

const pipelineUpdateSchema = z.object({
  name: z.string().min(1).max(80).default("Default"),
  // Optional, not defaulted: an omitted field must preserve the pipeline's
  // existing operating rules (e.g. a stale client that predates this field),
  // not silently clear them. An explicit "" still clears intentionally.
  operatingRulesMd: z.string().max(20000).optional(),
  stages: z.array(stageInputSchema).min(1, "Pipeline must have at least one stage."),
});

export async function PUT(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  let parsed;
  try {
    parsed = pipelineUpdateSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues[0]?.message ?? "Invalid pipeline payload.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();

  const { data, error } = await admin.rpc("rewrite_default_pipeline_with_approval_policy", {
    // undefined when omitted: dropped from the JSON body, so the RPC falls back
    // to its NULL default and coalesces to the pipeline's current rules.
    operating_rules_md: parsed.operatingRulesMd,
    pipeline_name: parsed.name,
    stage_payload: parsed.stages,
    target_workspace_id: workspaceId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const result = data as PipelineRewriteRpcResult | null;

  if (!result?.ok) {
    switch (result?.error_code) {
      case "pipeline_not_found":
        return NextResponse.json({ error: "Workspace has no default pipeline." }, { status: 404 });
      case "duplicate_stage_id": {
        const ids = result.duplicate_stage_ids ?? [];
        return NextResponse.json(
          {
            duplicateStageIds: ids,
            error: `Duplicate stage IDs: ${ids.join(", ")}`,
          },
          { status: 400 },
        );
      }
      case "duplicate_stage_slug": {
        const slugs = result.duplicate_stage_slugs ?? [];
        return NextResponse.json(
          { error: `Duplicate stage slug: ${slugs.join(", ")}` },
          { status: 400 },
        );
      }
      case "unknown_approver_member_ids": {
        const invalidIds = result.invalid_approver_member_ids ?? [];
        return NextResponse.json(
          {
            error: `Unknown approver member IDs: ${invalidIds.join(", ")}`,
            invalidApproverMemberIds: invalidIds,
          },
          { status: 400 },
        );
      }
      case "stage_delete_blocked": {
        const numbers = (result.blocking_session_numbers ?? []).map((number) => `#${number}`);
        return NextResponse.json(
          {
            error: `Cannot remove a stage that is the current stage of active sessions (${numbers.join(", ")}). Approve or archive them first.`,
          },
          { status: 409 },
        );
      }
      case "invalid_stage_payload":
        return NextResponse.json({ error: "Invalid pipeline payload." }, { status: 400 });
      default:
        return NextResponse.json({ error: "Failed to save pipeline." }, { status: 500 });
    }
  }

  const pipeline = await loadDefaultPipelineForWorkspace(admin, workspaceId);
  if (!pipeline) {
    return NextResponse.json({ error: "Workspace has no default pipeline." }, { status: 404 });
  }

  return NextResponse.json({ pipeline, success: true });
}
