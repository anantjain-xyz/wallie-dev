import { NextResponse } from "next/server";

import {
  repositoryOnboardingManualReadyPayloadSchema,
  repositoryOnboardingParamsSchema,
} from "@/lib/repo-onboarding/contracts";
import { GitHubAuthorMissingError } from "@/features/github/author-identity";
import {
  getRepositoryOnboardingState,
  markRepositoryOnboardingReady,
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

  return {
    currentMemberId: access.context.currentMember.id,
    parsed: parsed.data,
    status: 200 as const,
  };
}

function repositoryOnboardingErrorResponse(error: unknown) {
  if (error instanceof GitHubAuthorMissingError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }

  const message = error instanceof Error ? error.message : null;
  if (message === "Repository not found.") {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  if (message === "Wallie setup is unavailable for archived repositories.") {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (message === "GitHub installation not found for repository.") {
    return NextResponse.json({ error: message }, { status: 409 });
  }

  throw error;
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
  let result;
  try {
    result = await startRepositoryOnboarding({
      admin,
      repositoryId: authorized.parsed.repositoryId,
      requestedByMemberId: authorized.currentMemberId,
      workspaceId: authorized.parsed.workspaceId,
    });
  } catch (caught) {
    return repositoryOnboardingErrorResponse(caught);
  }

  return NextResponse.json(result, { status: 200 });
}

export async function PATCH(request: Request, context: RouteContext) {
  const authorized = await authorize(context);
  if ("error" in authorized) {
    return NextResponse.json({ error: authorized.error }, { status: authorized.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = repositoryOnboardingManualReadyPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid onboarding action." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  let result;
  try {
    result = await markRepositoryOnboardingReady({
      admin,
      repositoryId: authorized.parsed.repositoryId,
      workspaceId: authorized.parsed.workspaceId,
    });
  } catch (caught) {
    return repositoryOnboardingErrorResponse(caught);
  }

  return NextResponse.json(result, { status: 200 });
}
