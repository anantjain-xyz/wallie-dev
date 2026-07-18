import { NextResponse } from "next/server";
import { z } from "zod";

import { repositoryProfileSavePayloadSchema } from "@/lib/repo-inference/contracts";
import {
  RepositoryProfileError,
  saveWorkspaceRepositoryProfile,
} from "@/lib/repo-inference/server";
import { getLatestSandboxCapabilityCheck } from "@/lib/sandbox-capabilities/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const workspaceIdParamSchema = z.string().uuid("Workspace id must be a valid UUID.");

export async function PUT(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const parsedWorkspaceId = workspaceIdParamSchema.safeParse(workspaceId);

  if (!parsedWorkspaceId.success) {
    return NextResponse.json(
      { error: parsedWorkspaceId.error.issues[0]?.message ?? "Invalid workspace id." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsedWorkspaceId.data, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = repositoryProfileSavePayloadSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid repository profile payload." },
      { status: 400 },
    );
  }

  try {
    const admin = createSupabaseAdminClient();
    const [profile, latestSandboxCapabilityCheck] = await Promise.all([
      saveWorkspaceRepositoryProfile({
        admin,
        payload: parsed.data,
        workspaceId: parsedWorkspaceId.data,
      }),
      getLatestSandboxCapabilityCheck({
        admin,
        repositoryId: parsed.data.githubRepositoryId,
        workspaceId: parsedWorkspaceId.data,
      }),
    ]);

    return NextResponse.json({ latestSandboxCapabilityCheck, profile }, { status: 200 });
  } catch (error) {
    if (error instanceof RepositoryProfileError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    throw error;
  }
}
