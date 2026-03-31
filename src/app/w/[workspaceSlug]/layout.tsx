import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell/app-shell";
import {
  ensureProfileForUser,
  getWorkspaceBySlugForUser,
  hasAnyWorkspaceForUser,
  workspaceLoginRedirectPath,
} from "@/lib/auth";
import { loginPath, onboardingWorkspacePath } from "@/lib/routes";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type WorkspaceLayoutProps = {
  children: ReactNode;
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceLayout({
  children,
  params,
}: WorkspaceLayoutProps) {
  const { workspaceSlug } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(loginPath(workspaceLoginRedirectPath(workspaceSlug)));
  }

  await ensureProfileForUser(supabase, user);

  const workspace = await getWorkspaceBySlugForUser(supabase, workspaceSlug);

  if (!workspace) {
    if (!(await hasAnyWorkspaceForUser(supabase))) {
      redirect(onboardingWorkspacePath());
    }

    notFound();
  }

  return (
    <AppShell viewerEmail={user.email ?? null} workspace={workspace}>
      {children}
    </AppShell>
  );
}
