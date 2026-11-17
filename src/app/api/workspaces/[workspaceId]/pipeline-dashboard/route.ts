import { NextResponse } from "next/server";
import { z } from "zod";

import {
  PipelineWorkspaceUnavailableError,
  decodePipelineDashboardCursor,
  loadPipelineDashboardLanePage,
  loadPipelineDashboardSnapshot,
} from "@/features/pipeline/data";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const requestSchema = z.object({
  cursor: z.string().min(1),
  pipelineId: z.string().uuid(),
  seenIds: z.array(z.string().uuid()).max(5_000),
  stageId: z.string().uuid(),
});

const factoryIdSchema = z.string().uuid().optional();

function readFactoryId(request: Request) {
  const params = new URL(request.url).searchParams.getAll("factory");
  return factoryIdSchema.safeParse(params.length > 1 ? params : params[0]);
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) {
    return NextResponse.json(
      { code: "workspace_unavailable", error: access.error },
      { status: access.status },
    );
  }
  const factoryId = readFactoryId(request);
  if (!factoryId.success) return invalidFactory();
  try {
    const snapshot = await loadPipelineDashboardSnapshot({
      supabase: access.context.supabase,
      workspaceId,
      ...(factoryId.data ? { factoryId: factoryId.data } : {}),
    });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PipelineWorkspaceUnavailableError) return workspaceUnavailable();
    return NextResponse.json({ error: "Failed to load pipeline snapshot." }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId);

  if (!access.ok) {
    return NextResponse.json(
      { code: "workspace_unavailable", error: access.error },
      { status: access.status },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  const factoryId = readFactoryId(request);
  if (!factoryId.success) return invalidFactory();

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
      ...(factoryId.data ? { factoryId: factoryId.data } : {}),
      pipelineId: parsed.data.pipelineId,
      seenIds: parsed.data.seenIds,
      stageId: parsed.data.stageId,
      supabase: access.context.supabase,
      workspaceId,
    });

    if (!lane) {
      return NextResponse.json({ error: "Pipeline lane not found." }, { status: 404 });
    }

    return NextResponse.json({ lane }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PipelineWorkspaceUnavailableError) return workspaceUnavailable();
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load pipeline lane." },
      { status: 500 },
    );
  }
}

function invalidFactory() {
  return NextResponse.json({ error: "A valid factory is required." }, { status: 400 });
}

function workspaceUnavailable() {
  return NextResponse.json(
    { code: "workspace_unavailable", error: "Workspace not found." },
    { status: 404 },
  );
}
