import { NextResponse } from "next/server";
import { z } from "zod";

import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

const paramsSchema = z.object({
  sessionId: z.string().uuid("Session id is invalid."),
});

const artifactQuerySchema = z.object({
  stage: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
});

export async function GET(request: Request, context: RouteContext) {
  const params = await context.params;
  const parsedParams = paramsSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: parsedParams.error.issues[0]?.message ?? "Session id is invalid." },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const parsedQuery = artifactQuerySchema.safeParse({
    stage: url.searchParams.get("stage") ?? undefined,
  });
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: parsedQuery.error.issues[0]?.message ?? "Artifact query is invalid." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Sign in before viewing artifacts." }, { status: 401 });
  }

  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", parsedParams.data.sessionId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!sessionRow) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  let artifactQuery = supabase
    .from("session_artifacts")
    .select("artifact_json, created_at, id, stage_slug, version")
    .eq("session_id", parsedParams.data.sessionId)
    .order("version", { ascending: false });

  if (parsedQuery.data.stage) {
    artifactQuery = artifactQuery.eq("stage_slug", parsedQuery.data.stage);
  }

  const { data: artifactRows, error: artifactError } = await artifactQuery;
  if (artifactError) {
    return NextResponse.json({ error: artifactError.message }, { status: 500 });
  }

  return NextResponse.json({
    artifacts: (artifactRows ?? []).map((row) => ({
      createdAt: row.created_at,
      id: row.id,
      payload: row.artifact_json,
      stageSlug: row.stage_slug,
      version: row.version,
    })),
  });
}
