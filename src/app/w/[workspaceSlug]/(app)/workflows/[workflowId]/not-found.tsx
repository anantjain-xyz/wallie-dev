"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceWorkflowsPath } from "@/lib/routes";

export default function WorkflowEditorNotFound() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      notFound
      returnHref={workspaceWorkflowsPath(workspaceSlug)}
      returnLabel="Back to workflows"
    />
  );
}
