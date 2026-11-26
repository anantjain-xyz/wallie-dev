"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { PageFailure } from "@/components/ui/page-failure";
import { runListReturn } from "@/features/wallie/runs-list-state";
import { workspaceRunsPath } from "@/lib/routes";

type FailureProps = { notFound?: boolean; reset?: () => void };

export function RunInspectorFailure(props: FailureProps) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <Suspense
      fallback={
        <PageFailure
          {...props}
          returnHref={workspaceRunsPath(workspaceSlug)}
          returnLabel="Back to runs"
        />
      }
    >
      <ContextualRunFailure {...props} workspaceSlug={workspaceSlug} />
    </Suspense>
  );
}

function ContextualRunFailure({
  workspaceSlug,
  ...props
}: FailureProps & { workspaceSlug: string }) {
  const values = useSearchParams().getAll("fromRuns");
  const returnTo = runListReturn(workspaceSlug, values.length === 1 ? values[0] : undefined);
  return (
    <PageFailure
      {...props}
      returnHref={returnTo?.href ?? workspaceRunsPath(workspaceSlug)}
      returnLabel={returnTo?.label ?? "Back to runs"}
    />
  );
}
