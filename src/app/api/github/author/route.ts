import { NextRequest, NextResponse } from "next/server";

import { getGitHubConfigStatus, resolveGitHubAuthorOAuthConfig } from "@/features/github/config";
import { githubWorkspaceQuerySchema } from "@/features/github/contracts";
import { createGitHubAuthorState } from "@/features/github/author-identity";
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

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId);

  if (!access.ok) {
    return NextResponse.json(
      {
        error: access.error,
      },
      { status: access.status },
    );
  }

  const missingKeys = getGitHubConfigStatus().missingAuthorKeys;

  if (missingKeys.length > 0) {
    return NextResponse.json(
      {
        code: "missing_config",
        error: "GitHub author connection is unavailable until server config is complete.",
        missing: missingKeys,
      },
      { status: 503 },
    );
  }

  const env = parseServerEnv();
  const oauth = resolveGitHubAuthorOAuthConfig();
  const callbackUrl = new URL("/api/github/author/callback", env.NEXT_PUBLIC_APP_URL);
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  const state = createGitHubAuthorState({
    source: parsed.data.source ?? "settings",
    userId: access.context.user.id,
    workspaceId: access.context.workspace.id,
    workspaceSlug: access.context.workspace.slug,
  });

  authorizeUrl.searchParams.set("client_id", oauth.clientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("prompt", "select_account");

  return NextResponse.json(
    {
      authorizeUrl: authorizeUrl.toString(),
    },
    { status: 200 },
  );
}
