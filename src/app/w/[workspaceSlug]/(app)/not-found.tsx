"use client";
import { useParams } from "next/navigation";
import { PageFailure } from "@/components/ui/page-failure";
import { workspaceSessionsPath } from "@/lib/routes";
export default function WorkspaceNotFoundPage() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      notFound
      returnHref={workspaceSessionsPath(workspaceSlug)}
      returnLabel="Back to sessions"
    />
  );
}
