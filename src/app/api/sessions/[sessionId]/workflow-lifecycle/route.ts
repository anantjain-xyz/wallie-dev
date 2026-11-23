import { NextResponse } from "next/server";
import { z } from "zod";

import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };
const sessionIdSchema = z.string().uuid();
const generation = z.number().int().safe().positive();
const lifecycle = z.enum(["running", "paused", "canceled"]);
const intent = z
  .object({
    requestId: z.string().uuid(),
    expectedGeneration: generation.max(Number.MAX_SAFE_INTEGER - 1),
    action: z.enum(["pause", "resume", "cancel"]),
  })
  .strict();
const observed = z.object({
  execution: z.object({
    generation,
    lifecycle_status: lifecycle,
  }),
});

async function loadVisibleWorkflowRoot({ params }: Params) {
  const sessionId = sessionIdSchema.safeParse((await params).sessionId);
  if (!sessionId.success)
    return { response: NextResponse.json({ error: "Session not found." }, { status: 404 }) };
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };

  const { data, error } = await supabase
    .from("sessions")
    .select("id, workspace_id, factory_id")
    .eq("id", sessionId.data)
    .maybeSingle();
  if (error)
    return {
      response: NextResponse.json({ error: "Could not read the session." }, { status: 500 }),
    };
  if (!data)
    return { response: NextResponse.json({ error: "Session not found." }, { status: 404 }) };

  return {
    userId: user.id,
    scope: {
      p_root_session_id: data.id,
      p_workspace_id: data.workspace_id,
      p_factory_id: data.factory_id,
    },
  };
}

export async function GET(_request: Request, params: Params) {
  const root = await loadVisibleWorkflowRoot(params);
  if (root.response) return root.response;

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("read_factory_workflow_execution", root.scope);
  if (error) return NextResponse.json({ error: "Could not read the workflow." }, { status: 500 });
  const parsed = observed.safeParse(data);
  if (!parsed.success)
    return NextResponse.json({ error: "Workflow graph not found." }, { status: 404 });

  return NextResponse.json(
    {
      generation: parsed.data.execution.generation,
      status: parsed.data.execution.lifecycle_status,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request, params: Params) {
  const root = await loadVisibleWorkflowRoot(params);
  if (root.response) return root.response;

  const parsed = intent.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Provide the exact workflow action and generation." },
      { status: 400 },
    );

  const gated = await enforceRateLimit(
    "phaseAction",
    `${root.scope.p_workspace_id}:${root.userId}`,
  );
  if (gated.response) return gated.response;

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("control_factory_workflow_lifecycle_for_user", {
    ...root.scope,
    p_actor_user_id: root.userId,
    p_expected_generation: parsed.data.expectedGeneration,
    p_request_id: parsed.data.requestId,
    p_action: parsed.data.action,
  });
  switch (error?.code) {
    case undefined:
      return NextResponse.json(data);
    case "42501":
      return NextResponse.json(
        { error: "Workflow access or execution authority is unavailable." },
        { status: 403 },
      );
    case "P0002":
    case "PT404":
      return NextResponse.json({ error: "Workflow graph not found." }, { status: 404 });
    case "PT409":
    case "P0011":
      return NextResponse.json(
        { error: "The workflow changed. Refresh before retrying." },
        { status: 409 },
      );
    default:
      return NextResponse.json({ error: "Could not update the workflow." }, { status: 500 });
  }
}
