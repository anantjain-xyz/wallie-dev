import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
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
  approverMemberIds: z.array(z.string().uuid()).default([]),
});

const pipelineUpdateSchema = z.object({
  name: z.string().min(1).max(80).default("Default"),
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
  } catch (err) {
    if (err instanceof z.ZodError) {
      const message = err.issues[0]?.message ?? "Invalid pipeline payload.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Slugs must be unique within the pipeline.
  const slugs = new Set<string>();
  for (const stage of parsed.stages) {
    if (slugs.has(stage.slug)) {
      return NextResponse.json({ error: `Duplicate stage slug: ${stage.slug}` }, { status: 400 });
    }
    slugs.add(stage.slug);
  }

  const admin = createSupabaseAdminClient();

  const { data: pipelineRow, error: pipelineError } = await admin
    .from("pipelines")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .maybeSingle();

  if (pipelineError) {
    return NextResponse.json({ error: pipelineError.message }, { status: 500 });
  }
  if (!pipelineRow) {
    return NextResponse.json({ error: "Workspace has no default pipeline." }, { status: 404 });
  }

  // Validate approver IDs belong to this workspace; silently drop unknowns.
  const allMemberIds = Array.from(new Set(parsed.stages.flatMap((s) => s.approverMemberIds)));
  if (allMemberIds.length > 0) {
    const { data: existingMembers } = await admin
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("id", allMemberIds);
    const validIds = new Set((existingMembers ?? []).map((m) => m.id));
    for (const stage of parsed.stages) {
      stage.approverMemberIds = stage.approverMemberIds.filter((id) => validIds.has(id));
    }
  }

  // Load existing stages so we know what's safe to delete.
  const { data: existingStages, error: stagesError } = await admin
    .from("pipeline_stages")
    .select("id, slug")
    .eq("pipeline_id", pipelineRow.id);
  if (stagesError) {
    return NextResponse.json({ error: stagesError.message }, { status: 500 });
  }

  const incomingIds = new Set(
    parsed.stages.map((s) => s.id).filter((id): id is string => Boolean(id)),
  );
  const stagesToDelete = (existingStages ?? []).filter((s) => !incomingIds.has(s.id));

  // Block deletion of any stage that's the current_stage_id of an active session.
  if (stagesToDelete.length > 0) {
    const deleteIds = stagesToDelete.map((s) => s.id);
    const { data: blockingSessions, error: blockingError } = await admin
      .from("sessions")
      .select("id, number, current_stage_id")
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .in("current_stage_id", deleteIds);
    if (blockingError) {
      return NextResponse.json({ error: blockingError.message }, { status: 500 });
    }
    if (blockingSessions && blockingSessions.length > 0) {
      const numbers = blockingSessions.map((s) => `#${s.number}`).join(", ");
      return NextResponse.json(
        {
          error: `Cannot remove a stage that is the current stage of active sessions (${numbers}). Approve or archive them first.`,
        },
        { status: 409 },
      );
    }
  }

  // Apply: rename pipeline if needed, then upsert stages, then delete the
  // ones not present in the payload. The unique constraints on
  // (pipeline_id, slug) and (pipeline_id, position) make a naive
  // upsert-then-delete dangerous (could collide with a renamed stage).
  // Two-phase: first move all stages to a placeholder position to clear the
  // unique-position constraint, then write final positions.
  if (parsed.name) {
    await admin.from("pipelines").update({ name: parsed.name }).eq("id", pipelineRow.id);
  }

  // Step 1: shift existing stages out of the way with negative positions.
  if (existingStages && existingStages.length > 0) {
    for (let i = 0; i < existingStages.length; i++) {
      await admin
        .from("pipeline_stages")
        .update({ position: -(i + 1) })
        .eq("id", existingStages[i]!.id);
    }
  }

  // Step 2: upsert each incoming stage.
  for (let i = 0; i < parsed.stages.length; i++) {
    const stage = parsed.stages[i]!;
    const position = i + 1;
    if (stage.id && existingStages?.some((e) => e.id === stage.id)) {
      const { error: updateError } = await admin
        .from("pipeline_stages")
        .update({
          approver_member_ids: stage.approverMemberIds,
          description: stage.description,
          name: stage.name,
          position,
          prompt_template_md: stage.promptTemplateMd,
          slug: stage.slug,
        })
        .eq("id", stage.id);
      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
    } else {
      const { error: insertError } = await admin.from("pipeline_stages").insert({
        approver_member_ids: stage.approverMemberIds,
        description: stage.description,
        name: stage.name,
        pipeline_id: pipelineRow.id,
        position,
        prompt_template_md: stage.promptTemplateMd,
        slug: stage.slug,
        // workspace_id gets set by the enforce_pipeline_stage_refs trigger.
        workspace_id: workspaceId,
      });
      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
    }
  }

  // Step 3: delete stages that weren't in the payload.
  if (stagesToDelete.length > 0) {
    const { error: deleteError } = await admin
      .from("pipeline_stages")
      .delete()
      .in(
        "id",
        stagesToDelete.map((s) => s.id),
      );
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
