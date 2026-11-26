"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceRunsPath } from "@/lib/routes";

export default function RunNotFound() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      notFound
      returnHref={workspaceRunsPath(workspaceSlug)}
      returnLabel="Back to runs"
    />
  );
}
