"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceRunsPath } from "@/lib/routes";

export default function RunError({ retry, reset }: { retry?: () => void; reset?: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      reset={retry ?? reset}
      returnHref={workspaceRunsPath(workspaceSlug)}
      returnLabel="Back to runs"
    />
  );
}
