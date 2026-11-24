import { NextRequest, NextResponse } from "next/server";

import { parseServerEnv } from "@/env/server";
import {
  completeSlackConnectorAuthorization,
  consumeSlackConnectorAuthorization,
  slackCallbackInput,
  slackCallbackPath,
} from "@/lib/connectors/slack/setup";
import { readBoundedRequestBytes } from "@/lib/http/bounded-json-body";
import { workspaceSettingsPath } from "@/lib/routes";
import { decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseAuthIdentityOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

const postedCookie = "__Secure-wallie-slack-callback";
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: true,
  path: slackCallbackPath,
} as const;
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
type Destination = { workspaceSlug: string; factoryId: string };

function redirectResult(
  appUrl: string,
  destination: Destination | null,
  status: "installed" | "linked" | "error",
) {
  const path = destination
    ? `${workspaceSettingsPath(destination.workspaceSlug, {
        category: "integrations",
        factory: destination.factoryId,
        connector: "slack",
        slackResult: status,
      })}#connector-resources`
    : `/?slackResult=${status}`;
  const response = NextResponse.redirect(new URL(path, appUrl), { status: 303, headers });
  response.cookies.set(postedCookie, "", { ...cookieOptions, maxAge: 0 });
  return response;
}

function parsePostedCallback(request: NextRequest): unknown {
  const posted = request.cookies.get(postedCookie)?.value;
  if (!posted || posted.length > 2048) return null;
  try {
    return JSON.parse(decryptSecretValue(posted));
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const appUrl = parseServerEnv().NEXT_PUBLIC_APP_URL;
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return redirectResult(appUrl, null, "error");
  }
  const form = await readBoundedRequestBytes(request, 2048);
  if (!form.ok) return redirectResult(appUrl, null, "error");
  const parsed = slackCallbackInput.safeParse(
    Object.fromEntries(new URLSearchParams(new TextDecoder().decode(form.bytes))),
  );
  if (!parsed.success) return redirectResult(appUrl, null, "error");

  // A top-level GET can read Wallie's Lax session cookies after Slack form_post.
  const response = NextResponse.redirect(new URL(`${slackCallbackPath}?posted=1`, appUrl), {
    status: 303,
    headers,
  });
  response.cookies.set(postedCookie, encryptSecretValue(JSON.stringify(parsed.data)), {
    ...cookieOptions,
    maxAge: 60,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const appUrl = parseServerEnv().NEXT_PUBLIC_APP_URL;
  const params = request.nextUrl.searchParams;
  const parsed = slackCallbackInput.safeParse(
    params.get("posted") === "1" ? parsePostedCallback(request) : Object.fromEntries(params),
  );
  if (!parsed.success) return redirectResult(appUrl, null, "error");

  let destination: Destination | null = null;
  try {
    const user = await getSupabaseAuthIdentityOrNull(await createSupabaseServerClient(), {
      includeSessionId: true,
    });
    if (!user?.sessionId) return redirectResult(appUrl, null, "error");
    const admin = createSupabaseAdminClient();
    const flow = await consumeSlackConnectorAuthorization(admin, {
      state: parsed.data.state,
      userId: user.id,
      sessionId: user.sessionId,
    });
    if (!flow) return redirectResult(appUrl, null, "error");
    const access = await requireWorkspaceAccessById(flow.workspace_id, {
      requireManager: flow.purpose === "install",
    });
    if (!access.ok || access.context.user.id !== user.id)
      return redirectResult(appUrl, null, "error");

    destination = { factoryId: flow.factory_id, workspaceSlug: access.context.workspace.slug };
    if (!parsed.data.code) return redirectResult(appUrl, destination, "error");
    const status = await completeSlackConnectorAuthorization(
      admin,
      {
        p_workspace_id: flow.workspace_id,
        p_factory_id: flow.factory_id,
        p_actor_user_id: user.id,
      },
      flow,
      { state: parsed.data.state, code: parsed.data.code },
    );
    return redirectResult(appUrl, destination, status);
  } catch {
    return redirectResult(appUrl, destination, "error");
  }
}
