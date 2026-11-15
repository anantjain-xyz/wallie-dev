import { NextResponse } from "next/server";

import {
  loadRunTranscript,
  RunTranscriptCursorError,
  RunTranscriptResetError,
} from "@/features/wallie/run-transcript";
import {
  runTranscriptParamsSchema,
  runTranscriptQuerySchema,
} from "@/features/wallie/run-transcript-contracts";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ workspaceId: string; runId: string }> };
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, { params }: RouteContext) {
  const parsedParams = runTranscriptParamsSchema.safeParse(await params);
  const parsedQuery = runTranscriptQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsedParams.success || !parsedQuery.success) {
    return NextResponse.json(
      { error: "Invalid run transcript request." },
      { status: 400, headers },
    );
  }
  try {
    const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId);
    if (!access.ok)
      return NextResponse.json({ error: access.error }, { status: access.status, headers });
    const page = await loadRunTranscript({
      supabase: access.context.supabase,
      workspaceId: access.context.workspace.id,
      runId: parsedParams.data.runId,
      query: parsedQuery.data,
    });
    if (!page) return NextResponse.json({ error: "Run not found." }, { status: 404, headers });
    return NextResponse.json(page, { headers });
  } catch (error) {
    if (error instanceof RunTranscriptCursorError) {
      return NextResponse.json(
        { error: "Invalid run transcript cursor." },
        { status: 400, headers },
      );
    }
    if (error instanceof RunTranscriptResetError) {
      return NextResponse.json(
        { error: "Transcript source changed. Refresh the transcript.", code: "transcript_reset" },
        { status: 409, headers },
      );
    }
    return NextResponse.json({ error: "Could not load run transcript." }, { status: 500, headers });
  }
}
