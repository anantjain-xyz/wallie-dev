import { NextRequest, NextResponse } from "next/server";

import { getGitHubConfigStatus } from "@/features/github/config";
import { syncGitHubInstallationAndRepositories } from "@/features/github/service";
import { verifyGitHubInstallState } from "@/features/github/state";
import { parseServerEnv } from "@/env/server";
import { workspaceSettingsPath } from "@/lib/routes";

function buildCallbackRedirectPath(
  workspaceSlug: string | null,
  status: "connected" | "config_missing" | "failed" | "invalid_state",
) {
  if (!workspaceSlug) {
    return `/?github=${status}`;
  }

  return workspaceSettingsPath(workspaceSlug, {
    github: status,
  });
}

export async function GET(request: NextRequest) {
  const installationIdValue = request.nextUrl.searchParams.get("installation_id");
  const stateToken = request.nextUrl.searchParams.get("state");
  const state = verifyGitHubInstallState(stateToken);
  const env = parseServerEnv();

  if (!state) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(null, "invalid_state"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  const missingKeys = getGitHubConfigStatus().missingAppKeys;

  if (missingKeys.length > 0) {
    return NextResponse.redirect(
      new URL(
        buildCallbackRedirectPath(state.workspaceSlug, "config_missing"),
        env.NEXT_PUBLIC_APP_URL,
      ),
      { status: 303 },
    );
  }

  const installationId = Number(installationIdValue);

  if (!Number.isInteger(installationId) || installationId < 1) {
    return NextResponse.redirect(
      new URL(
        buildCallbackRedirectPath(state.workspaceSlug, "failed"),
        env.NEXT_PUBLIC_APP_URL,
      ),
      { status: 303 },
    );
  }

  try {
    await syncGitHubInstallationAndRepositories({
      installationId,
      workspaceId: state.workspaceId,
    });

    return NextResponse.redirect(
      new URL(
        buildCallbackRedirectPath(state.workspaceSlug, "connected"),
        env.NEXT_PUBLIC_APP_URL,
      ),
      { status: 303 },
    );
  } catch {
    return NextResponse.redirect(
      new URL(
        buildCallbackRedirectPath(state.workspaceSlug, "failed"),
        env.NEXT_PUBLIC_APP_URL,
      ),
      { status: 303 },
    );
  }
}
