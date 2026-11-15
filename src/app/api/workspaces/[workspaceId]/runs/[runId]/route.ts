import { NextResponse } from "next/server";

import {
  loadWorkspaceRunCatalogItem,
  RunCatalogWorkspaceUnavailableError,
} from "@/features/wallie/run-catalog";
import { runCatalogItemParamsSchema } from "@/features/wallie/run-catalog-contracts";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

type RouteContext = { params: Promise<{ workspaceId: string; runId: string }> };
const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: RouteContext) {
  const parsedParams = runCatalogItemParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid run catalog request." }, { status: 400, headers });
  }

  try {
    const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status, headers });
    }
    const run = await loadWorkspaceRunCatalogItem({
      supabase: access.context.supabase,
      workspaceId: access.context.workspace.id,
      workspaceSlug: access.context.workspace.slug,
      runId: parsedParams.data.runId,
    });
    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404, headers });
    }
    return NextResponse.json({ run }, { headers });
  } catch (error) {
    if (error instanceof RunCatalogWorkspaceUnavailableError) {
      return NextResponse.json({ error: "Workspace not found." }, { status: 404, headers });
    }
    return NextResponse.json({ error: "Could not load run." }, { status: 500, headers });
  }
}
