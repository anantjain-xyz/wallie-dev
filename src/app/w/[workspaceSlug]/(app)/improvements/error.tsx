"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceImprovementsPath } from "@/lib/routes";

export default function ImprovementsError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceImprovementsPath(workspaceSlug)}
      returnLabel="Back to improvements"
    />
  );
}
