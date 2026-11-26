"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceAgentsPath } from "@/lib/routes";

export default function AgentNotFound() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      notFound
      returnHref={workspaceAgentsPath(workspaceSlug)}
      returnLabel="Back to agents"
    />
  );
}
