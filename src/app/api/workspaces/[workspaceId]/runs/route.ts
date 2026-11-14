import { NextResponse } from "next/server";

import {
  loadWorkspaceRunCatalogPage,
  RunCatalogCursorError,
  RunCatalogWorkspaceUnavailableError,
} from "@/features/wallie/run-catalog";
import {
  runCatalogParamsSchema,
  runCatalogQuerySchema,
} from "@/features/wallie/run-catalog-contracts";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

type RouteContext = { params: Promise<{ workspaceId: string }> };
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, { params }: RouteContext) {
  const parsedParams = runCatalogParamsSchema.safeParse(await params);
  const parsedQuery = runCatalogQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsedParams.success || !parsedQuery.success) {
    return NextResponse.json({ error: "Invalid run catalog request." }, { status: 400, headers });
  }

  try {
    const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status, headers });
    }
    const page = await loadWorkspaceRunCatalogPage({
      supabase: access.context.supabase,
      workspaceId: access.context.workspace.id,
      workspaceSlug: access.context.workspace.slug,
      query: parsedQuery.data,
    });
    return NextResponse.json(page, { headers });
  } catch (error) {
    if (error instanceof RunCatalogWorkspaceUnavailableError) {
      return NextResponse.json({ error: "Workspace not found." }, { status: 404, headers });
    }
    if (error instanceof RunCatalogCursorError) {
      return NextResponse.json({ error: "Invalid run catalog cursor." }, { status: 400, headers });
    }
    return NextResponse.json({ error: "Could not load run catalog." }, { status: 500, headers });
  }
}
