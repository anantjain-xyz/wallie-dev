"use client";
import { useParams, usePathname } from "next/navigation";
import { PageFailure } from "@/components/ui/page-failure";
import { workspaceBasePath, workspaceSessionsPath } from "@/lib/routes";
export default function WorkspaceErrorPage({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const isSessionList = usePathname() === workspaceSessionsPath(workspaceSlug);
  return (
    <PageFailure
      reset={reset}
      returnHref={
        isSessionList ? workspaceBasePath(workspaceSlug) : workspaceSessionsPath(workspaceSlug)
      }
      returnLabel={isSessionList ? "Back to pipeline" : "Back to sessions"}
    />
  );
}
