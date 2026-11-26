"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceWorkflowsPath } from "@/lib/routes";

export default function WorkflowEditorError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceWorkflowsPath(workspaceSlug)}
      returnLabel="Back to workflows"
    />
  );
}
