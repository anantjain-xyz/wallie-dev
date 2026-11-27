"use client";

import { useParams, useSearchParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceFailureGroupsPath } from "@/lib/routes";

export default function FailureGroupsError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const factory = useSearchParams().get("factory") ?? undefined;
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceFailureGroupsPath(workspaceSlug, { factory })}
      returnLabel="Back to failure groups"
    />
  );
}
