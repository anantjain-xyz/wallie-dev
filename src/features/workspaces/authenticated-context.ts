import "server-only";

import { cache } from "react";
import { notFound, redirect } from "next/navigation";

import type { User } from "@supabase/supabase-js";

import {
  getWorkspaceBySlugForUser,
  hasAnyWorkspaceForUser,
  type WorkspaceSummary,
  workspaceLoginRedirectPath,
} from "@/lib/auth";
import { loginPath, onboardingWorkspacePath } from "@/lib/routes";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type AuthenticatedWorkspaceContext = {
  supabase: SupabaseServerClient;
  user: User;
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
      const user = await timing.segment(
        "auth.get-user",
        () => getSupabaseUserOrNull(supabase),
        (resolvedUser) => ({
          rows: resolvedUser ? 1 : 0,
        }),
      );

      if (!user) {
        redirect(loginPath(workspaceLoginRedirectPath(workspaceSlug)));
      }

      const workspace = await timing.segment(
        "workspace.by-slug",
        () => getWorkspaceBySlugForUser(supabase, workspaceSlug),
        (resolvedWorkspace) => ({
          payloadBytes: approximatePayloadSizeBytes(resolvedWorkspace),
          rows: resolvedWorkspace ? 1 : 0,
        }),
      );

      if (!workspace) {
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
        supabase,
        user,
        workspace,
      };
    });
  },
);
