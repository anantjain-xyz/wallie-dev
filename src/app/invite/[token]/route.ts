import { NextRequest, NextResponse } from "next/server";

import { ensureProfileForUser } from "@/lib/auth";
import { loginPath, workspaceBasePath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hashWorkspaceInvitationToken } from "@/lib/workspace-invitations/server";

type RouteContext = {
  params: Promise<{
    token: string;
  }>;
};

type AcceptWorkspaceInvitationResult =
  | {
      invitation_id: string;
      member: {
        id: string;
        role: string;
      };
      ok: true;
      workspace: {
        id: string;
        name: string;
        slug: string;
      };
    }
  | {
      actor_email?: string;
      error_code?: string;
      invited_email?: string;
      ok?: false;
    };

function getUserMetadataString(user: { user_metadata?: Record<string, unknown> }, keys: string[]) {
  for (const key of keys) {
    const value = user.user_metadata?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function invitePath(token: string) {
  return `/invite/${encodeURIComponent(token)}`;
}

function invitationErrorCopy(errorCode: string | undefined) {
  switch (errorCode) {
    case "already_accepted":
      return {
        status: 409,
        title: "Invitation already accepted",
        body: "This workspace invitation has already been used.",
      };
    case "email_mismatch":
      return {
        status: 403,
        title: "Use the invited email",
        body: "This invitation can only be accepted by the email address it was sent to.",
      };
    case "expired":
      return {
        status: 410,
        title: "Invitation expired",
        body: "Ask a workspace admin to resend your invitation.",
      };
    case "revoked":
      return {
        status: 410,
        title: "Invitation revoked",
        body: "This workspace invitation is no longer active.",
      };
    default:
      return {
        status: 404,
        title: "Invitation not found",
        body: "This invitation link is invalid or no longer available.",
      };
  }
}

function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function invitationErrorResponse({ errorCode, token }: { errorCode?: string; token: string }) {
  const copy = invitationErrorCopy(errorCode);
  const next = htmlEscape(invitePath(token));

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(copy.title)} - Wallie</title>
    <style>
      body { margin: 0; background: #f5f5f5; color: #1d1f22; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      section { width: min(100%, 420px); border: 1px solid #e0e0e0; border-radius: 8px; background: #fff; padding: 28px; box-shadow: 0 12px 40px rgba(29, 31, 34, 0.08); }
      h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.25; }
      p { margin: 0; color: #5f646d; font-size: 14px; line-height: 1.6; }
      form { margin-top: 22px; }
      button { min-height: 40px; border: 1px solid #d8d9de; border-radius: 6px; background: #fff; color: #1d1f22; cursor: pointer; font: inherit; font-size: 14px; font-weight: 650; padding: 8px 12px; }
      button:hover { background: #f5f5f5; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>${htmlEscape(copy.title)}</h1>
        <p>${htmlEscape(copy.body)}</p>
        <form action="/auth/signout" method="post">
          <input type="hidden" name="next" value="${next}" />
          <button type="submit">Sign out and try another account</button>
        </form>
      </section>
    </main>
  </body>
</html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: copy.status,
    },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { token } = await context.params;
  const next = invitePath(token);
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.redirect(new URL(loginPath(next), request.url), { status: 303 });
  }

  await ensureProfileForUser(supabase, user);

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("accept_workspace_invitation", {
    actor_avatar_url: getUserMetadataString(user, ["avatar_url", "picture"]),
    actor_email: user.email ?? "",
    actor_full_name: getUserMetadataString(user, ["full_name", "name"]),
    actor_user_id: user.id,
    invitation_token_hash: hashWorkspaceInvitationToken(token),
  });

  if (error) {
    throw error;
  }

  const result = data as AcceptWorkspaceInvitationResult | null;

  if (!result?.ok) {
    return invitationErrorResponse({
      errorCode: result?.error_code,
      token,
    });
  }

  return NextResponse.redirect(new URL(workspaceBasePath(result.workspace.slug), request.url), {
    status: 303,
  });
}
