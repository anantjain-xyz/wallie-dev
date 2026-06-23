import { NextResponse } from "next/server";

import {
  loadDefaultSessionRepositoryId,
  loadSessionRepositoryOptions,
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

  const { data: onboardingRow, error: onboardingError } = await access.context.supabase
    .from("workspace_onboarding")
    .select("selected_github_repository_id")
    .eq("workspace_id", access.context.workspace.id)
    .maybeSingle();

  if (onboardingError) {
    return NextResponse.json({ error: onboardingError.message }, { status: 500 });
  }

  const [defaultGithubRepositoryId, repositoryOptions] = await Promise.all([
    loadDefaultSessionRepositoryId({
      selectedRepositoryId: onboardingRow?.selected_github_repository_id ?? null,
      supabase: access.context.supabase,
      workspaceId: access.context.workspace.id,
    }),
    loadSessionRepositoryOptions({
      supabase: access.context.supabase,
      workspaceId: access.context.workspace.id,
    }),
  ]);

  return NextResponse.json({
    defaultGithubRepositoryId,
    repositoryOptions,
  });
}
