import { NextRequest, NextResponse } from "next/server";

import { getGitHubConfigStatus } from "@/features/github/config";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubAuthorizationCode,
  verifyGitHubInstallationOwnership,
} from "@/features/github/oauth";
import { syncGitHubInstallationAndRepositories } from "@/features/github/service";
import {
  advanceGitHubInstallFlow,
  consumeGitHubInstallFlow,
  githubCodeChallenge,
  githubInstallCookieName,
  githubInstallCookieOptions,
  loadGitHubInstallFlow,
  matchesGitHubStateCookie,
} from "@/features/github/state";
import { parseServerEnv } from "@/env/server";
import { workspaceOnboardingPath, workspaceSettingsPath } from "@/lib/routes";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type Destination = { source: string; workspaceSlug: string };

function redirectResult(
  appUrl: string,
  destination: Destination | null,
  status: "connected" | "config_missing" | "failed" | "invalid_state",
) {
  const path = !destination
    ? `/?github=${status}`
    : destination.source === "onboarding"
      ? `${workspaceOnboardingPath(destination.workspaceSlug)}?${new URLSearchParams({ github: status, step: "github" })}`
      : workspaceSettingsPath(destination.workspaceSlug, { github: status });
  const response = NextResponse.redirect(new URL(path, appUrl), {
    status: 303,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
  response.cookies.set(githubInstallCookieName, "", {
    ...githubInstallCookieOptions(appUrl),
    maxAge: 0,
  });
  return response;
}

export async function activateOnboardingGitHubStep(workspaceId: string) {
  await createSupabaseAdminClient()
    .from("workspace_onboarding")
    .update({
      current_step: "github",
      status: "in_progress",
    })
    .eq("workspace_id", workspaceId)
    .neq("status", "completed");
}

export async function GET(request: NextRequest) {
  const env = parseServerEnv();
  const state = request.nextUrl.searchParams.get("state");
  let destination: Destination | null = null;
  if (!matchesGitHubStateCookie(state, request.cookies.get(githubInstallCookieName)?.value)) {
    return redirectResult(env.NEXT_PUBLIC_APP_URL, null, "invalid_state");
  }

  try {
    const user = await getSupabaseUserOrNull(await createSupabaseServerClient());
    if (!user) return redirectResult(env.NEXT_PUBLIC_APP_URL, null, "invalid_state");
    const flow = await loadGitHubInstallFlow(state, user.id);
    if (!flow) return redirectResult(env.NEXT_PUBLIC_APP_URL, null, "invalid_state");
    const access = await requireWorkspaceAccessById(flow.workspace_id, { requireManager: true });
    if (!access.ok || access.context.user.id !== flow.user_id) {
      return redirectResult(env.NEXT_PUBLIC_APP_URL, null, "invalid_state");
    }
    destination = { source: flow.source, workspaceSlug: access.context.workspace.slug };
    if (getGitHubConfigStatus().missingAppKeys.length > 0) {
      return redirectResult(env.NEXT_PUBLIC_APP_URL, destination, "config_missing");
    }
    if (request.nextUrl.searchParams.has("error")) {
      return redirectResult(env.NEXT_PUBLIC_APP_URL, destination, "failed");
    }

    if (flow.phase === "install") {
      const rawId = request.nextUrl.searchParams.get("installation_id") ?? "";
      const installationId = Number(rawId);
      if (
        !/^[1-9]\d*$/.test(rawId) ||
        !Number.isSafeInteger(installationId) ||
        !(await advanceGitHubInstallFlow(flow, installationId))
      ) {
        return redirectResult(env.NEXT_PUBLIC_APP_URL, destination, "invalid_state");
      }
      const verifier = decryptSecretValue(flow.encrypted_code_verifier);
      // This callback's installation_id is untrusted until the separate user OAuth check.
      return NextResponse.redirect(
        buildGitHubAuthorizationUrl({ state, codeChallenge: githubCodeChallenge(verifier) }),
        {
          status: 303,
          headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
        },
      );
    }

    const code = request.nextUrl.searchParams.get("code");
    if (
      flow.phase !== "authorize" ||
      !flow.installation_id ||
      !code ||
      code.length > 1024 ||
      !(await consumeGitHubInstallFlow(flow))
    ) {
      return redirectResult(env.NEXT_PUBLIC_APP_URL, destination, "invalid_state");
    }
    // Consume before external requests so concurrent callbacks cannot replay this flow.
    const token = await exchangeGitHubAuthorizationCode({
      code,
      codeVerifier: decryptSecretValue(flow.encrypted_code_verifier),
    });
    await verifyGitHubInstallationOwnership({ installationId: flow.installation_id, token });
    const currentAccess = await requireWorkspaceAccessById(flow.workspace_id, {
      requireManager: true,
    });
    if (!currentAccess.ok || currentAccess.context.user.id !== flow.user_id) {
      return redirectResult(env.NEXT_PUBLIC_APP_URL, null, "invalid_state");
    }
    await syncGitHubInstallationAndRepositories({
      installationId: flow.installation_id,
      workspaceId: flow.workspace_id,
    });
    if (flow.source === "onboarding") {
      try {
        await activateOnboardingGitHubStep(flow.workspace_id);
      } catch {
        // The installation is connected; a best-effort onboarding hint cannot undo it.
      }
    }
    return redirectResult(env.NEXT_PUBLIC_APP_URL, destination, "connected");
  } catch {
    // Never expose OAuth codes, tokens, or upstream credential-bearing diagnostics.
    return redirectResult(env.NEXT_PUBLIC_APP_URL, destination, "failed");
  }
}
