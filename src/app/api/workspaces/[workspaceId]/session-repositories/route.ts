import { NextResponse } from "next/server";

import {
  loadSessionRepositoryOptionsWithPrimary,
  resolveDefaultSessionRepositoryId,
} from "@/features/sessions/repository-options";
import { workspaceIdParamsSchema } from "@/lib/workspaces";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  const parsedParams = workspaceIdParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: parsedParams.error.issues[0]?.message ?? "Workspace id is invalid." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const [onboardingResult, repositoryResult] = await Promise.all([
    access.context.supabase
      .from("workspace_onboarding")
      .select("selected_github_repository_id")
      .eq("workspace_id", access.context.workspace.id)
      .maybeSingle(),
    loadSessionRepositoryOptionsWithPrimary({
      supabase: access.context.supabase,
      workspaceId: access.context.workspace.id,
    }),
  ]);

  if (onboardingResult.error) {
    return NextResponse.json({ error: onboardingResult.error.message }, { status: 500 });
  }

  const defaultGithubRepositoryId = resolveDefaultSessionRepositoryId({
    primaryGithubRepositoryId: repositoryResult.primaryGithubRepositoryId,
    repositoryOptions: repositoryResult.repositoryOptions,
    selectedGithubRepositoryId: onboardingResult.data?.selected_github_repository_id ?? null,
  });

  return NextResponse.json(
    {
      defaultGithubRepositoryId,
      repositoryOptions: repositoryResult.repositoryOptions,
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
