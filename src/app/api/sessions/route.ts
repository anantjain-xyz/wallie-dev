import { NextResponse } from "next/server";

import { createSessionPayloadSchema } from "@/features/sessions/create";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { createSessionCommand } from "@/lib/sessions/creation-command";
import { buildAgentRunActionErrorResponse } from "@/lib/wallie/http";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

const failureStatus = {
  conflict: 409,
  failed: 500,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  unready: 422,
} as const;

export async function POST(request: Request) {
  const parsed = createSessionPayloadSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Session input is invalid." },
      { status: 400 },
    );
  }

  const { workspaceId, ...payload } = parsed.data;
  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const result = await createSessionCommand({
    actor: { memberId: access.context.currentMember.id, workspaceId },
    payload,
    reader: access.context.supabase,
  });
  if (!result.ok) {
    const { failure } = result;
    if (failure.kind === "wallie_action") {
      const { body, status } = buildAgentRunActionErrorResponse(failure.cause);
      return NextResponse.json(body, { status });
    }
    return NextResponse.json(
      { code: failure.code, error: failure.message },
      { status: failureStatus[failure.kind] },
    );
  }

  const { jobId, number, workspaceSlug } = result.session;
  return NextResponse.json(
    {
      canonicalUrl: workspaceSessionDetailPath(workspaceSlug, number),
      number,
      processScheduled: Boolean(jobId),
    },
    { status: 201 },
  );
}
