import { NextResponse } from "next/server";

import { repositoryOnboardingParamsSchema } from "@/lib/repo-onboarding/contracts";
import {
  getRepositoryOnboardingState,
  startRepositoryOnboarding,
} from "@/lib/repo-onboarding/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ repositoryId: string; workspaceId: string }>;
};

async function authorize(context: RouteContext) {
  const params = await context.params;
  const parsed = repositoryOnboardingParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid onboarding request.",
      status: 400 as const,
    };
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });
  if (!access.ok) {
    return { error: access.error, status: access.status };
  }

  return { parsed: parsed.data, status: 200 as const };
}

export async function GET(_request: Request, context: RouteContext) {
  const authorized = await authorize(context);
  if ("error" in authorized) {
    return NextResponse.json({ error: authorized.error }, { status: authorized.status });
  }

  const admin = createSupabaseAdminClient();
  const onboarding = await getRepositoryOnboardingState({
    admin,
    repositoryId: authorized.parsed.repositoryId,
    workspaceId: authorized.parsed.workspaceId,
  });

  return NextResponse.json({ onboarding }, { status: 200 });
}

export async function POST(_request: Request, context: RouteContext) {
  const authorized = await authorize(context);
  if ("error" in authorized) {
    return NextResponse.json({ error: authorized.error }, { status: authorized.status });
  }

  const admin = createSupabaseAdminClient();
  const result = await startRepositoryOnboarding({
    admin,
    repositoryId: authorized.parsed.repositoryId,
    workspaceId: authorized.parsed.workspaceId,
  });

  return NextResponse.json(result, { status: 200 });
}
