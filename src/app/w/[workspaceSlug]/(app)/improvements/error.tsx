"use client";

import { useParams, useSearchParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceImprovementsPath } from "@/lib/routes";

export default function ImprovementsError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const factory = useSearchParams().get("factory") ?? undefined;
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceImprovementsPath(workspaceSlug, { factory })}
      returnLabel="Back to improvements"
    />
  );
}
