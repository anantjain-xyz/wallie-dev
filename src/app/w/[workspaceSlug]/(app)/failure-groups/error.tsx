"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceFailureGroupsPath } from "@/lib/routes";

export default function FailureGroupsError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceFailureGroupsPath(workspaceSlug)}
      returnLabel="Back to failure groups"
    />
  );
}
