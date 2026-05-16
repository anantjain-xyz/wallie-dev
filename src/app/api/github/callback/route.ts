import { NextRequest, NextResponse } from "next/server";

import { getGitHubConfigStatus } from "@/features/github/config";
import { syncGitHubInstallationAndRepositories } from "@/features/github/service";
import { type GitHubInstallState, verifyGitHubInstallState } from "@/features/github/state";
import { parseServerEnv } from "@/env/server";
import { workspaceOnboardingPath, workspaceSettingsPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function buildCallbackRedirectPath(
  state: Pick<GitHubInstallState, "source" | "workspaceSlug"> | null,
  status: "connected" | "config_missing" | "failed" | "invalid_state",
) {
  if (!state?.workspaceSlug) {
    return `/?github=${status}`;
  }

  if (state.source === "onboarding") {
    const params = new URLSearchParams({ github: status, step: "github" });
    return `${workspaceOnboardingPath(state.workspaceSlug)}?${params.toString()}`;
  }

  return workspaceSettingsPath(state.workspaceSlug, {
    github: status,
  });
}

async function activateOnboardingGitHubStep(state: GitHubInstallState) {
  if (state.source !== "onboarding") return;

  const admin = createSupabaseAdminClient();
  await admin
    .from("workspace_onboarding")
    .update({
      current_step: "github",
      status: "in_progress",
    })
    .eq("workspace_id", state.workspaceId);
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

  try {
    await activateOnboardingGitHubStep(state);
  } catch {
    // Redirect destination is signed in state; a failed active-step hint should not break install.
  }

  const missingKeys = getGitHubConfigStatus().missingAppKeys;

  if (missingKeys.length > 0) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state, "config_missing"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  const installationId = Number(installationIdValue);

  if (!Number.isInteger(installationId) || installationId < 1) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state, "failed"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  try {
    await syncGitHubInstallationAndRepositories({
      installationId,
      workspaceId: state.workspaceId,
    });

    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state, "connected"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  } catch {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state, "failed"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }
}
