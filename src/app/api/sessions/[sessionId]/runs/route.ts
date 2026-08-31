import { NextResponse } from "next/server";

import {
  runHistoryParamsSchema,
  runHistoryQuerySchema,
  type RunHistoryErrorResponse,
  type RunHistoryResponse,
} from "@/features/wallie/contracts";
import { loadWallieRunPage } from "@/features/wallie/server";
import {
  buildWorkspaceMemberIndex,
  mapWorkspaceMemberRow,
} from "@/features/workspace-members/model";
import type { WorkspaceMemberRow } from "@/features/workspace-members/types";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, { params }: Params) {
  const parsedParams = runHistoryParamsSchema.safeParse(await params);
  const url = new URL(request.url);
  const parsedQuery = runHistoryQuerySchema.safeParse({
    createdAt: url.searchParams.get("createdAt") ?? undefined,
    id: url.searchParams.get("id") ?? undefined,
  });

  if (!parsedParams.success || !parsedQuery.success) {
    return NextResponse.json<RunHistoryErrorResponse>(
      { error: "Invalid run history cursor." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json<RunHistoryErrorResponse>({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id")
    .eq("id", parsedParams.data.sessionId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json<RunHistoryErrorResponse>(
      { error: sessionError.message },
      { status: 500 },
    );
  }

  if (!session) {
    return NextResponse.json<RunHistoryErrorResponse>(
      { error: "Session not found" },
      { status: 404 },
    );
  }

  const memberRowsPromise = supabase
    .from("workspace_members")
    .select("id, full_name, username, avatar_url, role, kind, user_id, is_active")
    .eq("workspace_id", session.workspace_id);

  try {
    const pagePromise = loadWallieRunPage({
      cursor:
        parsedQuery.data.createdAt && parsedQuery.data.id
          ? { createdAt: parsedQuery.data.createdAt, id: parsedQuery.data.id }
          : null,
      memberIndex: new Map(),
      sessionId: session.id,
      supabase,
    });
    const [{ data: memberRows, error: memberError }, page] = await Promise.all([
      memberRowsPromise,
      pagePromise,
    ]);

    if (memberError) {
      throw memberError;
    }

    const members = ((memberRows ?? []) as WorkspaceMemberRow[]).map(mapWorkspaceMemberRow);
    const memberIndex = buildWorkspaceMemberIndex(members);

    return NextResponse.json<RunHistoryResponse>({
      ...page,
      runs: page.runs.map((run) => ({
        ...run,
        requestedByMember: run.requestedByMemberId
          ? (memberIndex.get(run.requestedByMemberId) ?? null)
          : null,
      })),
    });
  } catch (error) {
    return NextResponse.json<RunHistoryErrorResponse>(
      { error: error instanceof Error ? error.message : "Could not load run history." },
      { status: 500 },
    );
  }
}
