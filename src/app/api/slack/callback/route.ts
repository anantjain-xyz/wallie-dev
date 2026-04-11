import { NextRequest, NextResponse } from "next/server";

import { parseServerEnv } from "@/env/server";
import { getSlackConfigStatus } from "@/features/slack/config";
import {
  exchangeSlackOAuthCode,
  upsertSlackInstallationForWorkspace,
} from "@/features/slack/service";
import { verifySlackInstallState } from "@/features/slack/state";
import { workspaceSettingsPath } from "@/lib/routes";

function buildCallbackRedirectPath(
  workspaceSlug: string | null,
  status: "connected" | "config_missing" | "failed" | "invalid_state",
) {
  if (!workspaceSlug) {
    return `/?slack=${status}`;
  }

  return workspaceSettingsPath(workspaceSlug, {
    slack: status,
  });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const stateToken = request.nextUrl.searchParams.get("state");
  const state = verifySlackInstallState(stateToken);
  const env = parseServerEnv();

  if (!state) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(null, "invalid_state"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  const missingKeys = getSlackConfigStatus().missingAppKeys;

  if (missingKeys.length > 0) {
    return NextResponse.redirect(
      new URL(
        buildCallbackRedirectPath(state.workspaceSlug, "config_missing"),
        env.NEXT_PUBLIC_APP_URL,
      ),
      { status: 303 },
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state.workspaceSlug, "failed"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  try {
    const callbackUrl = new URL("/api/slack/callback", env.NEXT_PUBLIC_APP_URL);
    const tokenResponse = await exchangeSlackOAuthCode({
      code,
      redirectUri: callbackUrl.toString(),
    });

    await upsertSlackInstallationForWorkspace({
      botToken: tokenResponse.access_token!,
      teamId: tokenResponse.team!.id!,
      teamName: tokenResponse.team?.name ?? null,
      workspaceId: state.workspaceId,
    });

    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state.workspaceSlug, "connected"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  } catch (error) {
    console.error("Slack OAuth callback failed", { error });

    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state.workspaceSlug, "failed"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }
}
