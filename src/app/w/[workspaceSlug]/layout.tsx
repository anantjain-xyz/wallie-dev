import type { ReactNode } from "react";

import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

export const preferredRegion = "home";

type WorkspaceLayoutProps = {
  children: ReactNode;
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceLayout({ children, params }: WorkspaceLayoutProps) {
  const { workspaceSlug } = await params;

  await loadAuthenticatedWorkspaceContext(workspaceSlug);

  return children;
}
