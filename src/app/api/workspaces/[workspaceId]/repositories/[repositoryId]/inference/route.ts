import { NextResponse } from "next/server";

import {
  inferRepositoryProfileForRepository,
  RepositoryProfileError,
} from "@/lib/repo-inference/server";
import { repositoryOnboardingParamsSchema } from "@/lib/repo-onboarding/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ repositoryId: string; workspaceId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const params = await context.params;
  const parsed = repositoryOnboardingParamsSchema.safeParse(params);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid inference request." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  try {
    const profile = await inferRepositoryProfileForRepository({
      admin: createSupabaseAdminClient(),
      repositoryId: parsed.data.repositoryId,
      workspaceId: parsed.data.workspaceId,
    });

    return NextResponse.json({ profile }, { status: 200 });
  } catch (error) {
    if (error instanceof RepositoryProfileError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    throw error;
  }
}
