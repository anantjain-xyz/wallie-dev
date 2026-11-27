import { NextResponse } from "next/server";
import { z } from "zod";

import {
  loadSessionRepositoryOptionsWithPrimary,
  resolveDefaultSessionRepositoryId,
} from "@/features/sessions/repository-options";
import type { SessionRepositoryOptionsResult } from "@/features/sessions/client";
import { isWorkspaceOperator } from "@/features/workspaces/authenticated-context";
import { factoryWritableRepositoryIds } from "@/lib/factory-definitions/repository-bindings";
import { loadActiveFactoryExecution } from "@/lib/factory-definitions/runtime-definition";
import { selectFactoryBaselinePipeline } from "@/lib/factory-definitions/storage";
import { loadFactoryRoutingCanary } from "@/lib/model-routing/canary-storage";
import {
  buildRoutingOverrideOptions,
  selectReviewedFactoryRoutingActivation,
} from "@/lib/model-routing/reviewed-activation";
import { loadDefaultPipelineForWorkspace, loadPipelineWithStages } from "@/lib/pipeline/stages";
import {
  browserSessionSetupHref,
  loadBrowserSessionFactories,
} from "@/lib/sessions/browser-factory";
import { workspaceIdParamsSchema } from "@/lib/workspaces";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};
const responseHeaders = { "Cache-Control": "private, no-store" };

function sessionOptions(options: SessionRepositoryOptionsResult) {
  return NextResponse.json(options, { headers: responseHeaders });
}

export async function GET(request: Request, context: RouteContext) {
  const params = await context.params;
  const parsedParams = workspaceIdParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: parsedParams.error.issues[0]?.message ?? "Workspace id is invalid." },
      { status: 400 },
    );
  }

  const requestedFactoryIds = new URL(request.url).searchParams.getAll("factoryId");
  const requestedFactoryId = z.string().uuid().optional().safeParse(requestedFactoryIds[0]);
  if (!requestedFactoryId.success || requestedFactoryIds.length > 1) {
    return NextResponse.json(
      { error: "Factory id is invalid." },
      { status: 400, headers: responseHeaders },
    );
  }

  const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const { currentMember, supabase, workspace } = access.context;
  const factoryId = requestedFactoryId.data?.toLowerCase();
  const [factory] = factoryId
    ? await loadBrowserSessionFactories({
        factoryId,
        member: currentMember,
        supabase,
        workspaceId: workspace.id,
      })
    : [];
  const factoryError = (error: string, status: number, code?: string) =>
    NextResponse.json(
      {
        error,
        setupHref: factoryId
          ? browserSessionSetupHref(code, {
              factoryId,
              member: currentMember,
              workspaceSlug: workspace.slug,
            })
          : undefined,
      },
      { status, headers: responseHeaders },
    );
  if (factoryId && !factory) {
    return factoryError("You can’t start a session in the selected factory.", 404);
  }
  if (factory && factory.status !== "active") {
    return factoryError(
      "Restore the archived factory before starting a session.",
      409,
      "factory_archived",
    );
  }
  const pinned = factory
    ? await loadActiveFactoryExecution(supabase, workspace.id, factory.id)
    : await loadActiveFactoryExecution(supabase, workspace.id);
  if (factory && !factory.isDefault && !pinned) {
    return factoryError(
      "Publish a factory definition before starting a session here.",
      422,
      "factory_definition_required",
    );
  }
  const target = factory ? { factoryId: factory.id, linearIssueLinking: factory.isDefault } : {};
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
    if (factory && !repositories.length) {
      return factoryError(
        "Reconnect a writable repository in this factory before starting a session.",
        422,
        "factory_repository_unavailable",
      );
    }

    let routingOverrideOptions;
    if (pinned.modelRouting && isWorkspaceOperator(currentMember)) {
      const scope = {
        workspaceId: workspace.id,
        factoryId: pinned.factoryId,
        activationNumber: pinned.activationNumber,
      };
      const [review, canary] = await Promise.all([
        selectReviewedFactoryRoutingActivation(supabase, scope),
        loadFactoryRoutingCanary(supabase, scope),
      ]);
      if (review.error) return NextResponse.json({ error: review.error.message }, { status: 500 });
      if (review.data) {
        routingOverrideOptions = buildRoutingOverrideOptions({
          definition: pinned,
          activationNumber: pinned.activationNumber,
          reviewedTargets: review.data.reviewed_targets,
          ...(canary ? { taskClassSlug: canary.taskClassSlug } : {}),
        });
      }
    }
    return sessionOptions({
      ...target,
      ...(pinned.implementationAgent ? { canDraftSpecification: true } : {}),
      ...(routingOverrideOptions ? { routingOverrideOptions } : {}),
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

  const [defaultFactory] = factory
    ? [factory]
    : await loadBrowserSessionFactories({
        defaultOnly: true,
        member: currentMember,
        supabase,
        workspaceId: workspace.id,
      });
  if (!defaultFactory || defaultFactory.status !== "active") {
    return factoryError("You can’t start a session in the default factory.", 404);
  }

  const [onboardingResult, repositoryResult, pipeline] = await Promise.all([
    supabase
      .from("workspace_onboarding")
      .select("selected_github_repository_id")
      .eq("workspace_id", workspace.id)
      .maybeSingle(),
    loadSessionRepositoryOptionsWithPrimary({
      factoryId: defaultFactory.id,
      supabase,
      workspaceId: workspace.id,
    }),
    factory
      ? selectFactoryBaselinePipeline(supabase, workspace.id, {
          id: factory.id,
          is_default: true,
        }).then(({ data, error }) => {
          if (error) throw error;
          return data ? loadPipelineWithStages(supabase, data.id) : null;
        })
      : loadDefaultPipelineForWorkspace(supabase, workspace.id),
  ]);

  if (onboardingResult.error) {
    return NextResponse.json({ error: onboardingResult.error.message }, { status: 500 });
  }
  if (factory && !pipeline?.stages.length) {
    return factoryError(
      "Configure at least one pipeline stage before starting a session.",
      422,
      "factory_pipeline_unavailable",
    );
  }

  const defaultGithubRepositoryId = resolveDefaultSessionRepositoryId({
    primaryGithubRepositoryId: repositoryResult.primaryGithubRepositoryId,
    repositoryOptions: repositoryResult.repositoryOptions,
    selectedGithubRepositoryId: onboardingResult.data?.selected_github_repository_id ?? null,
  });

  return sessionOptions({
    ...target,
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
