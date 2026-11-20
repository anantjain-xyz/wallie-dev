import { z } from "zod/v4";

import { evaluationControlErrorStatus } from "@/lib/factory-evaluations/evaluation-controls";
import {
  editFactoryJudgeProfileSchema,
  readFactoryJudgeProfile,
  revokeFactoryJudgeProfile,
  revokeFactoryJudgeProfileSchema,
  saveFactoryJudgeProfile,
} from "@/lib/factory-evaluations/judge-profile-controls";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };

async function judgeProfileAccess(params: RouteContext["params"]) {
  const workspaceId = z.uuid().safeParse((await params).workspaceId);
  if (!workspaceId.success) {
    return {
      ok: false as const,
      response: Response.json({ error: "Invalid workspace ID." }, { status: 400, headers }),
    };
  }
  const access = await requireWorkspaceAccessById(workspaceId.data, { requireManager: true });
  if (!access.ok) {
    return {
      ok: false as const,
      response: Response.json({ error: access.error }, { status: access.status, headers }),
    };
  }
  return {
    ok: true as const,
    workspaceId: access.context.workspace.id,
    actorUserId: access.context.user.id,
  };
}

function profileFailure(error: unknown) {
  const status = evaluationControlErrorStatus(error);
  const message: Partial<Record<typeof status, string>> = {
    403: "Workspace admin access is required.",
    404: "The workspace or judge profile is unavailable.",
    409: "The judge profile changed. Reload before saving.",
    422: "Check the provider, model, and dedicated judge key.",
  };
  return Response.json(
    { error: message[status] ?? "Could not update the judge profile." },
    { status, headers },
  );
}

export async function GET(_request: Request, { params }: RouteContext) {
  const access = await judgeProfileAccess(params);
  if (!access.ok) return access.response;
  try {
    const profile = await readFactoryJudgeProfile(createSupabaseAdminClient(), access);
    return Response.json({ profile }, { headers });
  } catch (error) {
    return profileFailure(error);
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const access = await judgeProfileAccess(params);
  if (!access.ok) return access.response;
  const payload = await readBoundedJsonBody(request, 8192);
  const input = payload.ok ? editFactoryJudgeProfileSchema.safeParse(payload.body) : null;
  if (!input?.success) {
    return Response.json({ error: "Invalid judge profile." }, { status: 400, headers });
  }
  try {
    const profile = await saveFactoryJudgeProfile(createSupabaseAdminClient(), access, input.data);
    return Response.json({ profile }, { headers });
  } catch (error) {
    return profileFailure(error);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const access = await judgeProfileAccess(params);
  if (!access.ok) return access.response;
  const payload = await readBoundedJsonBody(request, 256);
  const input = payload.ok ? revokeFactoryJudgeProfileSchema.safeParse(payload.body) : null;
  if (!input?.success) {
    return Response.json(
      { error: "The current profile revision is required." },
      { status: 400, headers },
    );
  }
  try {
    const profile = await revokeFactoryJudgeProfile(
      createSupabaseAdminClient(),
      access,
      input.data.expectedRevision,
    );
    return Response.json({ profile }, { headers });
  } catch (error) {
    return profileFailure(error);
  }
}
