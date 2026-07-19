import "server-only";

import { cache } from "react";
import { notFound, redirect } from "next/navigation";

import {
  getWorkspaceBySlugForUser,
  hasAnyWorkspaceForUser,
  type WorkspaceSummary,
  workspaceLoginRedirectPath,
} from "@/lib/auth";
import { loginPath, onboardingWorkspacePath } from "@/lib/routes";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import { type SupabaseAuthIdentity, verifySupabaseAuthIdentity } from "@/lib/supabase/auth";
import type { Tables } from "@/lib/supabase/database.types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type AuthenticatedWorkspaceContext = {
  currentMember: Pick<Tables<"workspace_members">, "id" | "is_active" | "kind" | "role">;
  supabase: SupabaseServerClient;
  user: SupabaseAuthIdentity;
  workspace: WorkspaceSummary & { avatar_path: string | null };
};

export const loadAuthenticatedWorkspaceContext = cache(
  async (workspaceSlug: string): Promise<AuthenticatedWorkspaceContext> => {
    return withServerTiming("workspace.auth-context", { workspaceSlug }, async (timing) => {
      const supabase = await timing.segment(
        "create-supabase-server-client",
        () => createSupabaseServerClient(),
        () => ({ rows: 1 }),
      );
      const verification = await timing.segment(
        "auth.verify-claims",
        () => verifySupabaseAuthIdentity(supabase, { includeEmail: true }),
        (result) => ({
          authUserRequests: result.authUserRequests,
          claimsVerifications: result.claimsVerifications,
          method: result.method,
          rows: result.identity ? 1 : 0,
        }),
      );
      const user = verification.identity;

      if (!user) {
        redirect(loginPath(workspaceLoginRedirectPath(workspaceSlug)));
      }

      const workspaceAccess = await timing.segment(
        "workspace.by-slug",
        () => getWorkspaceBySlugForUser(supabase, workspaceSlug, user.id),
        (resolvedAccess) => ({
          payloadBytes: approximatePayloadSizeBytes(resolvedAccess),
          rows: resolvedAccess ? 2 : 0,
        }),
      );

      if (!workspaceAccess) {
        const hasAnyWorkspace = await timing.segment(
          "workspace.has-any",
          () => hasAnyWorkspaceForUser(supabase),
          (value) => ({ value }),
        );

        if (!hasAnyWorkspace) {
          redirect(onboardingWorkspacePath());
        }

        notFound();
      }

      return {
        currentMember: workspaceAccess.currentMember,
        supabase,
        user,
        workspace: workspaceAccess.workspace,
      };
    });
  },
);
