import { NextResponse } from "next/server";
import { z } from "zod";

import {
  PipelineWorkspaceUnavailableError,
  decodePipelineDashboardCursor,
  loadPipelineDashboardLanePage,
  loadPipelineDashboardSnapshot,
} from "@/features/pipeline/data";
import { PIPELINE_SEARCH_MAX_LENGTH, PIPELINE_STATUS_FILTERS } from "@/features/pipeline/types";
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

const querySchema = z.object({
  factory: z.string().uuid().optional(),
  q: z.string().trim().max(PIPELINE_SEARCH_MAX_LENGTH).default(""),
  status: z.enum(PIPELINE_STATUS_FILTERS).default("all"),
});

function readQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  const read = (key: string) => {
    const values = params.getAll(key);
    return values.length > 1 ? values : values[0];
  };
  return querySchema.safeParse({ factory: read("factory"), q: read("q"), status: read("status") });
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
  const query = readQuery(request);
  if (!query.success) return invalidQuery(query.error);
  const { factory, q, status } = query.data;
  try {
    const snapshot = await loadPipelineDashboardSnapshot({
      ...(factory ? { factoryId: factory } : {}),
      ...(q || status !== "all" ? { filters: { query: q, status } } : {}),
      supabase: access.context.supabase,
      workspaceId,
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
  const query = readQuery(request);
  if (!query.success) return invalidQuery(query.error);
  const { factory, q, status } = query.data;

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
      ...(factory ? { factoryId: factory } : {}),
      ...(q || status !== "all" ? { filters: { query: q, status } } : {}),
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

function invalidQuery(error: z.ZodError) {
  return NextResponse.json(
    {
      error: error.issues.some((issue) => issue.path[0] === "factory")
        ? "A valid factory is required."
        : "A valid Pipeline search and status are required.",
    },
    { status: 400 },
  );
}

function workspaceUnavailable() {
  return NextResponse.json(
    { code: "workspace_unavailable", error: "Workspace not found." },
    { status: 404 },
  );
}
