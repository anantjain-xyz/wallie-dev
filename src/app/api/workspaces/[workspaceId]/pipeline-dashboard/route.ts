import { NextResponse } from "next/server";
import { z } from "zod";

import {
  decodePipelineDashboardCursor,
  loadPipelineDashboardLanePage,
} from "@/features/pipeline/data";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const querySchema = z.object({
  cursor: z.string().min(1),
  pipelineId: z.string().uuid(),
  stageId: z.string().uuid(),
});

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId);

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    cursor: url.searchParams.get("cursor"),
    pipelineId: url.searchParams.get("pipelineId"),
    stageId: url.searchParams.get("stageId"),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "A valid lane cursor is required." }, { status: 400 });
  }

  const cursor = decodePipelineDashboardCursor(parsed.data.cursor);
  if (
    !cursor ||
    cursor.pipelineId !== parsed.data.pipelineId ||
    cursor.stageId !== parsed.data.stageId
  ) {
    return NextResponse.json({ error: "The lane cursor is invalid or expired." }, { status: 400 });
  }

  try {
    const lane = await loadPipelineDashboardLanePage({
      cursor,
      pipelineId: parsed.data.pipelineId,
      stageId: parsed.data.stageId,
      supabase: access.context.supabase,
      workspaceId,
    });

    if (!lane) {
      return NextResponse.json({ error: "Pipeline lane not found." }, { status: 404 });
    }

    return NextResponse.json({ lane }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load pipeline lane." },
      { status: 500 },
    );
  }
}
