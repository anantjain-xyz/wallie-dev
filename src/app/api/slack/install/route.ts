import { NextRequest, NextResponse } from "next/server";

import { parseServerEnv } from "@/env/server";
import { getSlackConfigStatus } from "@/features/slack/config";
import { slackWorkspaceQuerySchema } from "@/features/slack/contracts";
import { createSlackInstallState } from "@/features/slack/state";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const SLACK_OAUTH_SCOPES = ["app_mentions:read", "chat:write", "chat:write.public"];

export async function GET(request: NextRequest) {
  const parsed = slackWorkspaceQuerySchema.safeParse({
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

  const missingKeys = getSlackConfigStatus().missingAppKeys;

  if (missingKeys.length > 0) {
    return NextResponse.json(
      {
        code: "missing_config",
        error: "Slack install flow is unavailable until server config is complete.",
        missing: missingKeys,
      },
      { status: 503 },
    );
  }

  const env = parseServerEnv();
  const state = createSlackInstallState({
    userId: access.context.user.id,
    workspaceId: access.context.workspace.id,
    workspaceSlug: access.context.workspace.slug,
  });
  const callbackUrl = new URL("/api/slack/callback", env.NEXT_PUBLIC_APP_URL);
  const installUrl = new URL("https://slack.com/oauth/v2/authorize");

  installUrl.searchParams.set("client_id", env.SLACK_CLIENT_ID ?? "");
  installUrl.searchParams.set("scope", SLACK_OAUTH_SCOPES.join(","));
  installUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  installUrl.searchParams.set("state", state);

  return NextResponse.json(
    {
      installUrl: installUrl.toString(),
    },
    { status: 200 },
  );
}
