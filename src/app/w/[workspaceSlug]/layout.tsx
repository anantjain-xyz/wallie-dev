import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";

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

  return <AppShell workspaceSlug={workspaceSlug}>{children}</AppShell>;
}
