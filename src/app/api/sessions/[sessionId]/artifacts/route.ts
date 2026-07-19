import { NextResponse } from "next/server";
import { z } from "zod";

import { renderMarkdownToHtml } from "@/components/shared/markdown-content.server";
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

const artifactQuerySchema = z
  .object({
    stage: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    latest: z.literal("true").optional(),
    version: z.coerce.number().int().positive().optional(),
  })
  .refine(({ latest, version }) => !(latest && version), {
    message: "Choose either latest or a version, not both.",
  });

function formatAuthorLabel(provider: string | null | undefined, model: string | null | undefined) {
  if (!provider && !model) return "Agent";
  if (provider === "claude-code") return model ? `Claude Code (${model})` : "Claude Code";
  if (provider === "codex") return model ? `Codex (${model})` : "Codex";
  if (provider && model) return `${provider} (${model})`;
  return provider ?? model ?? "Agent";
}

/**
 * Pair each artifact version with the successful run that produced it.
 *
 * `markRunSuccess` runs after `insertArtifact` + the awaiting_review pointer flip,
 * so a producing run's `finished_at` is always >= its artifact's `created_at`.
 * Pre-reset successful runs finish earlier and must not be reused — especially
 * during the window where the replacement artifact is visible but the new run
 * is not yet marked success (trailing-count mapping would pick an old author).
 */
function mapAuthorsByFinishedAt(
  artifactRows: Array<{ created_at: string; version: number }>,
  runRows: Array<{
    finished_at: string | null;
    model_name: string | null;
    model_provider: string | null;
  }>,
): Map<number, string> {
  const artifactsAsc = [...artifactRows].sort((left, right) => left.version - right.version);
  const runsAsc = runRows
    .filter(
      (run): run is typeof run & { finished_at: string } => typeof run.finished_at === "string",
    )
    .sort((left, right) => Date.parse(left.finished_at) - Date.parse(right.finished_at));

  const authorsByVersion = new Map<number, string>();
  let runIndex = 0;
  for (const artifact of artifactsAsc) {
    const artifactTime = Date.parse(artifact.created_at);
    while (runIndex < runsAsc.length) {
      const run = runsAsc[runIndex]!;
      runIndex += 1;
      if (Date.parse(run.finished_at) < artifactTime) continue;
      authorsByVersion.set(artifact.version, formatAuthorLabel(run.model_provider, run.model_name));
      break;
    }
  }
  return authorsByVersion;
}

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
    latest: url.searchParams.get("latest") ?? undefined,
    stage: url.searchParams.get("stage") ?? undefined,
    version: url.searchParams.get("version") ?? undefined,
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

  const { latest, stage, version } = parsedQuery.data;

  if (latest || version) {
    let bodyQuery = supabase
      .from("session_artifacts")
      .select("artifact_json, created_at, id, stage_slug, version")
      .eq("session_id", parsedParams.data.sessionId)
      .eq("stage_slug", stage)
      .order("version", { ascending: false });

    if (version) {
      bodyQuery = bodyQuery.eq("version", version);
    }

    const { data: artifactRow, error: artifactError } = await bodyQuery.limit(1).maybeSingle();
    if (artifactError) {
      return NextResponse.json({ error: artifactError.message }, { status: 500 });
    }
    if (!artifactRow) {
      return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }

    const payload = artifactRow.artifact_json;
    return NextResponse.json({
      artifact: {
        createdAt: artifactRow.created_at,
        id: artifactRow.id,
        payload,
        sanitizedHtml: typeof payload === "string" ? await renderMarkdownToHtml(payload) : null,
        stageSlug: artifactRow.stage_slug,
        version: artifactRow.version,
      },
    });
  }

  const { data: artifactRows, error: artifactError } = await supabase
    .from("session_artifacts")
    .select("created_at, id, stage_slug, version")
    .eq("session_id", parsedParams.data.sessionId)
    .eq("stage_slug", stage)
    .order("version", { ascending: false });

  if (artifactError) {
    return NextResponse.json({ error: artifactError.message }, { status: 500 });
  }

  const [{ data: feedbackRows, error: feedbackError }, { data: runRows, error: runError }] =
    await Promise.all([
      supabase
        .from("session_artifact_feedback")
        .select("target_version")
        .eq("session_id", parsedParams.data.sessionId)
        .eq("stage_slug", stage),
      supabase
        .from("agent_runs")
        .select("finished_at, model_name, model_provider, status")
        .eq("session_id", parsedParams.data.sessionId)
        .eq("stage_slug", stage)
        .eq("status", "success")
        .order("finished_at", { ascending: true }),
    ]);

  if (feedbackError) {
    return NextResponse.json({ error: feedbackError.message }, { status: 500 });
  }
  if (runError) {
    return NextResponse.json({ error: runError.message }, { status: 500 });
  }

  const rejectedVersions = new Set((feedbackRows ?? []).map((row) => row.target_version));
  const authorsByVersion = mapAuthorsByFinishedAt(artifactRows ?? [], runRows ?? []);

  return NextResponse.json({
    artifacts: (artifactRows ?? []).map((row) => ({
      attempt: row.version,
      authorLabel: authorsByVersion.get(row.version) ?? "Agent",
      changesRequested: rejectedVersions.has(row.version),
      createdAt: row.created_at,
      id: row.id,
      stageSlug: row.stage_slug,
      version: row.version,
    })),
  });
}
