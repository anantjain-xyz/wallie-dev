"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceScorersPath } from "@/lib/routes";

export default function ScorersError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceScorersPath(workspaceSlug)}
      returnLabel="Back to scorers"
    />
  );
}
