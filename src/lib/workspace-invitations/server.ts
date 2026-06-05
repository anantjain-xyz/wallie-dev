import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { WORKSPACE_INVITATION_EXPIRES_DAYS } from "@/lib/workspace-invitations/contracts";

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

type AuthErrorLike = {
  code?: string;
  message?: string;
  name?: string;
  status?: number;
};

export function createWorkspaceInvitationToken() {
  return randomBytes(32).toString("base64url");
}

export function hashWorkspaceInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function workspaceInvitationExpiresAt(now = new Date()) {
  return new Date(now.getTime() + WORKSPACE_INVITATION_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
}

export function buildWorkspaceInvitationAcceptUrl(requestUrl: string, token: string) {
  const confirmUrl = new URL("/auth/confirm", requestUrl);
  confirmUrl.searchParams.set("next", `/invite/${encodeURIComponent(token)}`);

  return confirmUrl.toString();
}

function isAlreadyRegisteredAuthError(error: AuthErrorLike | null | undefined) {
  if (!error) return false;
  const message = error.message?.toLowerCase() ?? "";
  const code = error.code?.toLowerCase() ?? "";

  return (
    error.status === 422 ||
    code.includes("already") ||
    message.includes("already registered") ||
    message.includes("already been registered") ||
    message.includes("user already") ||
    message.includes("email address has already")
  );
}

export async function sendWorkspaceInvitationEmail({
  acceptUrl,
  admin,
  email,
}: {
  acceptUrl: string;
  admin: SupabaseAdminClient;
  email: string;
}) {
  const inviteResult = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: acceptUrl,
  });

  if (!inviteResult.error) {
    return;
  }

  if (!isAlreadyRegisteredAuthError(inviteResult.error)) {
    throw inviteResult.error;
  }

  const magicLinkResult = await admin.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: acceptUrl,
      shouldCreateUser: false,
    },
  });

  if (magicLinkResult.error) {
    throw magicLinkResult.error;
  }
}
