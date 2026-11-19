import { NextResponse } from "next/server";

import {
  loadSessionRepositoryOptionsWithPrimary,
  resolveDefaultSessionRepositoryId,
} from "@/features/sessions/repository-options";
import type { SessionRepositoryOptionsResult } from "@/features/sessions/client";
import { factoryWritableRepositoryIds } from "@/lib/factory-definitions/repository-bindings";
import { loadActiveFactoryExecution } from "@/lib/factory-definitions/runtime-definition";
import { loadDefaultPipelineForWorkspace } from "@/lib/pipeline/stages";
import { workspaceIdParamsSchema } from "@/lib/workspaces";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

function sessionOptions(options: SessionRepositoryOptionsResult) {
  return NextResponse.json(options, { headers: { "Cache-Control": "private, no-store" } });
}

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

  const { supabase, workspace } = access.context;
  const pinned = await loadActiveFactoryExecution(supabase, workspace.id);
  if (pinned) {
    const { data: repositories, error } = await supabase
      .from("github_repositories")
      .select("id, full_name, github_installations!inner(id)")
      .eq("workspace_id", workspace.id)
      .eq("factory_id", pinned.factoryId)
      .eq("is_archived", false)
      .eq("github_installations.workspace_id", workspace.id)
      .eq("github_installations.suspended", false)
      .in("id", factoryWritableRepositoryIds(pinned))
      .order("full_name", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return sessionOptions({
      ...(pinned.implementationAgent ? { canDraftSpecification: true } : {}),
      defaultGithubRepositoryId: pinned.repositoryId,
      factoryDefinitionDigest: pinned.canonicalDigest,
      pipelineId: pinned.pipelineId,
      repositoryOptions: repositories.map(({ id, full_name }) => ({ id, fullName: full_name })),
      stageOptions: pinned.stages.map(({ description, id, name }, index) => ({
        description,
        id,
        name,
        position: index + 1,
      })),
    });
  }

  const [onboardingResult, repositoryResult, pipeline] = await Promise.all([
    supabase
      .from("workspace_onboarding")
      .select("selected_github_repository_id")
      .eq("workspace_id", workspace.id)
      .maybeSingle(),
    loadSessionRepositoryOptionsWithPrimary({
      supabase,
      workspaceId: workspace.id,
    }),
    loadDefaultPipelineForWorkspace(supabase, workspace.id),
  ]);

  if (onboardingResult.error) {
    return NextResponse.json({ error: onboardingResult.error.message }, { status: 500 });
  }

  const defaultGithubRepositoryId = resolveDefaultSessionRepositoryId({
    primaryGithubRepositoryId: repositoryResult.primaryGithubRepositoryId,
    repositoryOptions: repositoryResult.repositoryOptions,
    selectedGithubRepositoryId: onboardingResult.data?.selected_github_repository_id ?? null,
  });

  return sessionOptions({
    defaultGithubRepositoryId,
    pipelineId: pipeline?.id ?? null,
    repositoryOptions: repositoryResult.repositoryOptions,
    stageOptions:
      pipeline?.stages.map(({ description, id, name, position }) => ({
        description,
        id,
        name,
        position,
      })) ?? [],
  });
}
