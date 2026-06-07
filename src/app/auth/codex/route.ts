import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath, resolveAuthenticatedSettingsPath } from "@/lib/auth";
import { startCodexDeviceAuthFlow } from "@/lib/codex/device-auth";
import { loginPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  loadRequiredVercelSandboxConnection,
  VercelSandboxConnectionInvalidError,
  VercelSandboxConnectionMissingError,
} from "@/lib/vercel-sandbox/server";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  const acceptsJson = wantsJson(request);

  const fallbackSettingsPath = user ? await resolveAuthenticatedSettingsPath(supabase) : "/";
  const next = normalizeNextPath(request.nextUrl.searchParams.get("next"), fallbackSettingsPath);

  if (!user) {
    if (acceptsJson) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.redirect(
      new URL(loginPath(`/auth/codex?next=${encodeURIComponent(next)}`), request.url),
      { status: 303 },
    );
  }

  if (!acceptsJson) {
    const url = new URL(next, request.url);
    url.searchParams.set("codex_connect", "chatgpt_device_required");
    return NextResponse.redirect(url, { status: 303 });
  }

  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  let vercelConnection: Awaited<ReturnType<typeof loadRequiredVercelSandboxConnection>>;
  try {
    vercelConnection = await loadRequiredVercelSandboxConnection(
      createSupabaseAdminClient(),
      access.context.workspace.id,
    );
  } catch (error) {
    if (
      error instanceof VercelSandboxConnectionMissingError ||
      error instanceof VercelSandboxConnectionInvalidError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const flow = await startCodexDeviceAuthFlow({
      userId: user.id,
      vercelCredentials: vercelConnection.credentials,
    });
    return NextResponse.json(flow, { status: flow.status === "error" ? 500 : 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start Codex sign-in." },
      { status: 500 },
    );
  }
}

function wantsJson(request: NextRequest): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}
