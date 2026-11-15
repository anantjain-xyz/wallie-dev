import { NextResponse } from "next/server";

import { listRunArtifacts, RunArtifactCursorError } from "@/features/wallie/run-artifacts";
import {
  runArtifactListQuerySchema,
  runArtifactScopeSchema,
} from "@/features/wallie/run-artifacts-contracts";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";
const headers = { "Cache-Control": "private, no-store" };
type RouteContext = { params: Promise<{ workspaceId: string; runId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const scope = runArtifactScopeSchema.safeParse(await params);
  const query = runArtifactListQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!scope.success || !query.success) {
    return NextResponse.json(
      { error: "Invalid artifact catalog request." },
      { status: 400, headers },
    );
  }
  try {
    const access = await requireWorkspaceAccessById(scope.data.workspaceId);
    if (!access.ok)
      return NextResponse.json({ error: access.error }, { status: access.status, headers });
    const page = await listRunArtifacts(
      {
        supabase: access.context.supabase,
        workspaceId: access.context.workspace.id,
        runId: scope.data.runId,
      },
      query.data,
    );
    return page
      ? NextResponse.json(page, { headers })
      : NextResponse.json({ error: "Run not found." }, { status: 404, headers });
  } catch (error) {
    if (error instanceof RunArtifactCursorError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers });
    }
    return NextResponse.json({ error: "Could not load run artifacts." }, { status: 500, headers });
  }
}
