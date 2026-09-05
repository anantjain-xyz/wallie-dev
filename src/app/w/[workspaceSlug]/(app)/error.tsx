"use client";
import { useParams } from "next/navigation";
import { PageFailure } from "@/components/ui/page-failure";
import { workspaceSessionsPath } from "@/lib/routes";
export default function WorkspaceErrorPage({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceSessionsPath(workspaceSlug)}
      returnLabel="Back to sessions"
    />
  );
}
