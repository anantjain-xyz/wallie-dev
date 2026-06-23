import type { ReactNode } from "react";

import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";

export const preferredRegion = "home";

type WorkspaceLayoutProps = {
  children: ReactNode;
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceLayout({ children, params }: WorkspaceLayoutProps) {
  const { workspaceSlug } = await params;

  await loadWorkspaceLayoutContext(workspaceSlug);

  return children;
}
