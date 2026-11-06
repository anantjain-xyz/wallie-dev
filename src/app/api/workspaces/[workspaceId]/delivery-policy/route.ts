import { NextResponse } from "next/server";
import { z } from "zod";

import { deliveryPolicyUpdateSchema, mapDeliveryPolicy } from "@/lib/delivery-policy/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };

const pipelineIdSchema = z.string().uuid();

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const pipelineId = pipelineIdSchema.safeParse(
    new URL(request.url).searchParams.get("pipelineId"),
  );
  if (!pipelineId.success) {
    return NextResponse.json({ error: "A valid pipeline id is required." }, { status: 400 });
  }

  const { supabase, workspace } = access.context;
  const { data: pipeline, error: pipelineError } = await supabase
    .from("pipelines")
    .select("id")
    .eq("id", pipelineId.data)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (pipelineError) {
    return NextResponse.json({ error: "Could not load the delivery policy." }, { status: 500 });
  }
  if (!pipeline) return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });

  const { data: current, error: currentError } = await supabase
    .from("delivery_policies")
    .select("current_revision_id")
    .eq("pipeline_id", pipelineId.data)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (currentError) {
    return NextResponse.json({ error: "Could not load the delivery policy." }, { status: 500 });
  }
  if (!current) return NextResponse.json({ policy: null });

  const { data: revision, error: revisionError } = await supabase
    .from("delivery_policy_revisions")
    .select("*")
    .eq("id", current.current_revision_id)
    .eq("pipeline_id", pipelineId.data)
    .eq("workspace_id", workspace.id)
    .single();
  if (revisionError || !revision) {
    return NextResponse.json({ error: "Could not load the delivery policy." }, { status: 500 });
  }

  return NextResponse.json({ policy: mapDeliveryPolicy(revision) });
}

export async function PUT(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = deliveryPolicyUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid delivery policy." },
      { status: 400 },
    );
  }

  const { data, error } = await createSupabaseAdminClient().rpc("save_delivery_policy", {
    p_workspace_id: access.context.workspace.id,
    p_pipeline_id: parsed.data.pipelineId,
    p_actor_user_id: access.context.user.id,
    p_expected_revision: parsed.data.expectedRevision,
    p_requirements: parsed.data.requirements,
  });
  if (error) {
    if (error.code === "PT409") {
      return NextResponse.json(
        { error: "The delivery policy changed. Reload it before saving again." },
        { status: 409 },
      );
    }
    if (error.code === "42501") {
      return NextResponse.json({ error: "Workspace admin access is required." }, { status: 403 });
    }
    if (
      error.code === "22023" ||
      error.code === "23503" ||
      error.code === "23514" ||
      error.code === "P0002"
    ) {
      return NextResponse.json({ error: "Invalid pipeline or delivery policy." }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not save the delivery policy." }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Could not save the delivery policy." }, { status: 500 });
  }

  return NextResponse.json({ policy: mapDeliveryPolicy(data) });
}
