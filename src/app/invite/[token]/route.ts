import { NextRequest, NextResponse } from "next/server";

import { ARROW_LEFT_PATH } from "@/components/shared/icons/arrow-left-icon";
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

const requestNewInvitation = "Ask the person who invited you to send a new link.";

function invitationErrorCopy(errorCode: string | undefined) {
  switch (errorCode) {
    case "already_accepted":
      return {
        status: 409,
        title: "Invitation already accepted",
        body: "Go back to Wallie and open the workspace with the account that received the invitation.",
      };
    case "email_mismatch":
      return {
        status: 403,
        title: "Use the invited email",
        body: "Sign out, then sign in with the email address the invitation was sent to.",
      };
    case "expired":
      return {
        status: 410,
        title: "Invitation expired",
        body: requestNewInvitation,
      };
    case "revoked":
      return {
        status: 410,
        title: "Invitation revoked",
        body: requestNewInvitation,
      };
    default:
      return {
        status: 404,
        title: "Invitation not found",
        body: requestNewInvitation,
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
      * { box-sizing: border-box; }
      :root {
        color-scheme: light dark;
        --sheet: light-dark(#fff, #1d2027);
        --ink: light-dark(#1d2027, #f7f8fa);
        --muted: light-dark(#5b616b, #b9bec7);
        --accent: light-dark(#4f46e5, #a5b4fc);
        --accent-ink: light-dark(#fff, #13161b);
      }
      body { margin: 0; background: var(--sheet); color: var(--ink); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { min-height: 100svh; display: grid; place-items: center; padding: 24px max(16px, env(safe-area-inset-right)) 24px max(16px, env(safe-area-inset-left)); }
      section { width: min(100%, 400px); }
      h1 { margin: 0 0 8px; font-size: 1.75rem; line-height: 1.25; letter-spacing: -0.025em; font-weight: 600; text-wrap: balance; }
      p { margin: 0; color: var(--muted); font-size: 0.875rem; line-height: 1.6; }
      .actions { display: grid; justify-items: start; gap: 4px; margin-top: 16px; }
      a { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; color: var(--muted); font-size: 0.875rem; text-underline-offset: 3px; }
      a svg { width: 16px; height: 16px; flex-shrink: 0; }
      a:hover { color: var(--ink); }
      form { margin: 0; }
      button { min-height: 44px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: var(--accent-ink); cursor: pointer; font: inherit; font-size: 0.875rem; font-weight: 600; padding: 8px 12px; }
      button:hover { background: color-mix(in srgb, var(--accent) 88%, var(--sheet)); }
      a, button { touch-action: manipulation; }
      a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>${htmlEscape(copy.title)}</h1>
        <p>${htmlEscape(copy.body)}</p>
        <div class="actions">
          ${
            errorCode === "email_mismatch"
              ? `<form action="/auth/signout" method="post">
            <input type="hidden" name="next" value="${next}" />
            <button type="submit">Use a different account</button>
          </form>`
              : ""
          }
          <a href="/">
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
              <path d="${ARROW_LEFT_PATH}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>Back to Wallie</span>
          </a>
        </div>
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
