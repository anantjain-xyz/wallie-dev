"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceAgentsPath } from "@/lib/routes";

export default function AgentsError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceAgentsPath(workspaceSlug)}
      returnLabel="Back to agents"
    />
  );
}
