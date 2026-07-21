import { NextRequest, NextResponse } from "next/server";

import {
  cancelCodexDeviceAuthFlow,
  consumeAuthenticatedCodexDeviceAuthFlow,
  deleteCodexDeviceAuthFlow,
  getCodexDeviceAuthFlowSnapshot,
} from "@/lib/codex/device-auth";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveAuthenticatedSettingsPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import {
  loadRequiredWorkspaceSandboxConnection,
  SandboxConnectionInvalidError,
  SandboxConnectionMissingError,
} from "@/lib/sandbox-connections/server";
import type { SandboxConnection } from "@/lib/sandbox/types";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  const acceptsJson = wantsJson(request);

  if (!user) {
    if (acceptsJson) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.redirect(
      new URL(loginPath("/?codex_connect=unauthenticated"), request.url),
      { status: 303 },
    );
  }

  const flowId = request.nextUrl.searchParams.get("flowId");
  if (!flowId) {
    return respondError(supabase, request, acceptsJson, "state_missing", 400);
  }

  const sandboxConnection = await loadRequestSandboxConnection(request);
  if ("response" in sandboxConnection) {
    return sandboxConnection.response;
  }
  const authSandboxInput = sandboxConnection.connection
    ? { connection: sandboxConnection.connection }
    : {};

  const snapshot = await getCodexDeviceAuthFlowSnapshot({
    flowId,
    userId: user.id,
    ...authSandboxInput,
  });
  if (!snapshot) {
    return respondError(supabase, request, acceptsJson, "state_invalid", 404);
  }

  if (snapshot.status !== "authenticated") {
    return acceptsJson
      ? NextResponse.json(snapshot, { status: 200 })
      : redirectWithFlash(supabase, request, "pending");
  }

  const authenticated = await consumeAuthenticatedCodexDeviceAuthFlow({ flowId, userId: user.id });
  if (!authenticated) {
    return respondError(supabase, request, acceptsJson, "state_invalid", 409);
  }

  const now = new Date().toISOString();
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("user_codex_credentials")
    .upsert(
      {
        access_token_expires_at: null,
        account_email: authenticated.metadata.accountEmail,
        account_id: authenticated.metadata.accountId,
        auth_cache_last_refresh: authenticated.metadata.lastRefresh,
        auth_lock_expires_at: null,
        auth_lock_run_id: null,
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: "chatgpt_auth_json",
        credential_version: 1,
        encrypted_credential: encryptSecretValue(authenticated.authJson),
        scope: null,
        updated_at: now,
        user_id: user.id,
      },
      { onConflict: "user_id" },
    )
    .select("account_email, auth_cache_last_refresh, credential_type, updated_at")
    .single();

  if (error) {
    return respondError(supabase, request, acceptsJson, "persist_failed", 500, error.message);
  }

  await deleteCodexDeviceAuthFlow({
    flowId,
    userId: user.id,
    ...authSandboxInput,
  });

  if (acceptsJson) {
    return NextResponse.json({
      accountEmail: data.account_email,
      authCacheLastRefresh: data.auth_cache_last_refresh,
      connected: true,
      credentialType: data.credential_type,
      updatedAt: data.updated_at,
    });
  }

  return redirectWithFlash(supabase, request, "success");
}

export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const flowId = request.nextUrl.searchParams.get("flowId");
  if (!flowId) {
    return NextResponse.json({ error: "Missing flowId." }, { status: 400 });
  }

  const sandboxConnection = await loadRequestSandboxConnection(request);
  if ("response" in sandboxConnection) {
    return sandboxConnection.response;
  }
  const authSandboxInput = sandboxConnection.connection
    ? { connection: sandboxConnection.connection }
    : {};

  const canceled = await cancelCodexDeviceAuthFlow({
    flowId,
    userId: user.id,
    ...authSandboxInput,
  });
  return NextResponse.json({ canceled });
}

function wantsJson(request: NextRequest): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

async function loadRequestSandboxConnection(request: NextRequest): Promise<
  | {
      connection?: SandboxConnection;
    }
  | {
      response: NextResponse;
    }
> {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) {
    return {};
  }

  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) {
    return {
      response: NextResponse.json({ error: access.error }, { status: access.status }),
    };
  }

  try {
    const connection = await loadRequiredWorkspaceSandboxConnection(
      createSupabaseAdminClient(),
      access.context.workspace.id,
    );
    return { connection: connection.connection };
  } catch (error) {
    if (
      error instanceof SandboxConnectionMissingError ||
      error instanceof SandboxConnectionInvalidError
    ) {
      return {
        response: NextResponse.json({ error: error.message }, { status: 400 }),
      };
    }
    throw error;
  }
}

function respondError(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  request: NextRequest,
  acceptsJson: boolean,
  flash: string,
  status: number,
  detail?: string,
) {
  if (acceptsJson) {
    return NextResponse.json({ error: detail ?? flash, status: flash }, { status });
  }

  return redirectWithFlash(supabase, request, flash);
}

async function redirectWithFlash(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  request: NextRequest,
  flash: string,
) {
  const settingsPath = await resolveAuthenticatedSettingsPath(supabase);
  const redirectUrl = new URL(settingsPath, request.url);
  redirectUrl.searchParams.set("codex_connect", flash);
  return NextResponse.redirect(redirectUrl, { status: 303 });
}
