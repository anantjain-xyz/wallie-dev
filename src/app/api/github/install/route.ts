import { NextRequest, NextResponse } from "next/server";

import { getGitHubConfigStatus } from "@/features/github/config";
import { githubWorkspaceQuerySchema } from "@/features/github/contracts";
import { resolveGitHubInstallSlug } from "@/features/github/service";
import { createGitHubInstallState } from "@/features/github/state";
import { parseServerEnv } from "@/env/server";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export async function GET(request: NextRequest) {
  const parsed = githubWorkspaceQuerySchema.safeParse({
    source: request.nextUrl.searchParams.get("source") ?? undefined,
    workspaceId: request.nextUrl.searchParams.get("workspaceId"),
  });

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Workspace id is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json(
      {
        error: access.error,
      },
      { status: access.status },
    );
  }

  const missingKeys = getGitHubConfigStatus().missingAppKeys;

  if (missingKeys.length > 0) {
    return NextResponse.json(
      {
        code: "missing_config",
        error: "GitHub App installation is unavailable until server config is complete.",
        missing: missingKeys,
      },
      { status: 503 },
    );
  }

  const env = parseServerEnv();
  const installSlug = await resolveGitHubInstallSlug();
  const state = createGitHubInstallState({
    source: parsed.data.source ?? "settings",
    userId: access.context.user.id,
    workspaceId: access.context.workspace.id,
    workspaceSlug: access.context.workspace.slug,
  });
  const callbackUrl = new URL("/api/github/callback", env.NEXT_PUBLIC_APP_URL);
  const installUrl = new URL(`https://github.com/apps/${installSlug}/installations/new`);

  installUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  installUrl.searchParams.set("state", state);

  return NextResponse.json(
    {
      installUrl: installUrl.toString(),
    },
    { status: 200 },
  );
}
