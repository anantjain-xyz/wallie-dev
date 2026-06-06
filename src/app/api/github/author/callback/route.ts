import { NextRequest, NextResponse } from "next/server";

import { getGitHubConfigStatus } from "@/features/github/config";
import {
  exchangeGitHubAuthorCode,
  fetchGitHubAuthorUser,
  upsertGitHubAuthorIdentityForUser,
  verifyGitHubAuthorState,
} from "@/features/github/author-identity";
import { parseServerEnv } from "@/env/server";
import { workspaceOnboardingPath, workspaceSettingsPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function buildCallbackRedirectPath(
  state: ReturnType<typeof verifyGitHubAuthorState>,
  status: "connected" | "config_missing" | "failed" | "invalid_state" | "wrong_user",
) {
  if (!state?.workspaceSlug) {
    return `/?github_author=${status}`;
  }

  if (state.source === "onboarding") {
    const params = new URLSearchParams({ github_author: status, step: "github" });
    return `${workspaceOnboardingPath(state.workspaceSlug)}?${params.toString()}`;
  }

  return workspaceSettingsPath(state.workspaceSlug, {
    github_author: status,
  });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = verifyGitHubAuthorState(request.nextUrl.searchParams.get("state"));
  const env = parseServerEnv();

  if (!state) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(null, "invalid_state"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  const missingKeys = getGitHubConfigStatus().missingAuthorKeys;

  if (missingKeys.length > 0) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state, "config_missing"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state, "failed"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user || user.id !== state.userId) {
    return NextResponse.redirect(
      new URL(buildCallbackRedirectPath(state, "wrong_user"), env.NEXT_PUBLIC_APP_URL),
      { status: 303 },
    );
  }

  try {
    const redirectUri = new URL("/api/github/author/callback", env.NEXT_PUBLIC_APP_URL).toString();
    const accessToken = await exchangeGitHubAuthorCode(code, redirectUri);
    const githubUser = await fetchGitHubAuthorUser(accessToken);

    await upsertGitHubAuthorIdentityForUser({
      admin: createSupabaseAdminClient(),
      githubUser,
      userId: user.id,
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
